// Real-VM confinement conformance — adversarial, modeled on @anthropic-ai/sandbox-runtime's attack
// tests. Boots an actual Fedora CoreOS VM (vfkit on macOS, QEMU on Linux) and tries to ESCAPE it, then
// asserts with a HOST-SIDE oracle (never trusts the guest's own error): the escape target on the host
// is untouched, egress never reaches the network. Gated: MONAD_VM_IT=1 + the base image present.
//
// This is the launcher's ADMISSION GATE (docs/proposals/sandbox-package-extraction.md §4): a backend
// that can't prove these does not ship.
//
// Boots are expensive (seconds on vfkit/KVM, minutes on QEMU/TCG), so each describe block boots ONE VM
// (a distinct agent per net mode / isolation peer) and reuses it across every attack.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { imagesDir } from '../../src/image.ts';
import { configureVmBackend, vmLauncher } from '../../src/index.ts';
import { configureVmToolchain } from '../../src/toolchain.ts';

// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only gate for the heavy real-VM run
const ENABLED = Bun.env.MONAD_VM_IT === '1' && (process.platform === 'darwin' || process.platform === 'linux');

async function drain(stream: ReadableStream<Uint8Array> | undefined): Promise<string> {
  return stream ? await new Response(stream).text() : '';
}

type Policy = Parameters<NonNullable<typeof vmLauncher.spawn>>[2];

async function run(argv: string[], policy: Policy, agentId: string): Promise<{ code: number; stdout: string }> {
  if (!vmLauncher.spawn) throw new Error('vm launcher has no spawn');
  const proc = vmLauncher.spawn(argv, { sessionId: 's', agentId }, policy);
  const stdout = await drain(proc.stdout);
  const code = await proc.exited;
  return { code, stdout };
}
const sh = (script: string, policy: Policy, agent: string) => run(['sh', '-c', script], policy, agent);

let prepared = false;
beforeAll(async () => {
  if (!ENABLED) return;
  configureVmToolchain({});
  configureVmBackend({ imageConsent: async () => true, idleTtlMs: 5_000, bootTimeoutMs: 600_000 });
  if (!existsSync(imagesDir())) throw new Error(`no base image in ${imagesDir()} — download it first`);
  await vmLauncher.prepare?.();
  prepared = true;
}, 120_000);

describe.skipIf(!ENABLED)('net:none confinement (fs escape, credential, privilege)', () => {
  const AGENT = 'agt_none';
  let ws: string; // writable mount
  let ro: string; // readonly mount
  let hostSecretOutside: string; // a host file NOT mounted — the escape oracle
  const NET: Policy = {} as Policy;

  beforeAll(async () => {
    if (!prepared) return;
    ws = await mkdtemp(join(tmpdir(), 'monad-vm-ws-'));
    ro = await mkdtemp(join(tmpdir(), 'monad-vm-ro-'));
    hostSecretOutside = join(mkdtempSync(join(tmpdir(), 'monad-vm-secret-')), 'host-secret');
    writeFileSync(hostSecretOutside, 'HOST_SECRET_NEVER_REACHABLE');
    Object.assign(NET, { writableRoots: [ws], readableRoots: [ro], net: 'none' });
  }, 30_000);

  afterAll(async () => {
    await vmLauncher.disposeAgent?.(AGENT);
    for (const d of [ws, ro]) if (d) rmSync(d, { recursive: true, force: true });
  });

  test('boots and runs a command unprivileged (uid 1001, no wheel → no sudo)', async () => {
    const r = await sh('echo OK; id -u; whoami; sudo -n true 2>&1 || echo NOSUDO', NET, AGENT);
    expect(r.stdout).toContain('OK');
    expect(r.stdout).toContain('1001');
    expect(r.stdout).toContain('monad');
    expect(r.stdout).toContain('NOSUDO');
  }, 600_000);

  test('write OUTSIDE any mount stays in the guest namespace — the host escape target is untouched', async () => {
    await sh(`echo pwned > ${hostSecretOutside} 2>/dev/null; echo x > /etc/monad-escape 2>/dev/null; true`, NET, AGENT);
    expect(existsSync('/etc/monad-escape')).toBe(false); // the test host's /etc
    expect(await Bun.file(hostSecretOutside).text()).toBe('HOST_SECRET_NEVER_REACHABLE');
  }, 600_000);

  test('symlink escape: a link in the writable mount → host path does NOT grant host write', async () => {
    // srt's highest-value port: symlink inside an allowed dir pointing outside, then write through it.
    // In a VM the link resolves in the guest namespace, so the host target is never reached.
    await sh(
      `ln -sf ${hostSecretOutside} ${ws}/escape-link; echo pwned > ${ws}/escape-link 2>/dev/null;` +
        `ln -sf /etc ${ws}/etc-link; echo pwned > ${ws}/etc-link/monad-escape2 2>/dev/null; true`,
      NET,
      AGENT
    );
    expect(await Bun.file(hostSecretOutside).text()).toBe('HOST_SECRET_NEVER_REACHABLE');
    expect(existsSync('/etc/monad-escape2')).toBe(false);
  }, 600_000);

  test('write to a READONLY mount fails (ro virtio-fs), directly and via a symlink into it', async () => {
    const r = await sh(
      `echo direct > ${ro}/ro-write 2>&1; echo "RC=$?"; ln -sf ${ro} ${ws}/ro-link; echo viaLink > ${ws}/ro-link/x 2>&1; echo "RC2=$?"`,
      NET,
      AGENT
    );
    expect(r.stdout).not.toContain('RC=0');
    expect(r.stdout).not.toContain('RC2=0');
    expect(existsSync(join(ro, 'ro-write'))).toBe(false);
    expect(existsSync(join(ro, 'x'))).toBe(false);
  }, 600_000);

  test('a path NOT mounted (host credential file) is absent in the guest', async () => {
    const r = await sh(`cat ${hostSecretOutside} 2>&1; ls -la ${hostSecretOutside} 2>&1; true`, NET, AGENT);
    expect(r.stdout).not.toContain('HOST_SECRET_NEVER_REACHABLE');
  }, 600_000);

  test('the unprivileged workload cannot alter the guest firewall or bring up an interface', async () => {
    const r = await sh(
      'nft flush ruleset 2>&1; echo "NFT=$?"; ip link add dummy0 type dummy 2>&1; echo "IP=$?"; ' +
        'ip link set lo down 2>&1; echo "LO=$?"',
      NET,
      AGENT
    );
    expect(r.stdout).not.toContain('NFT=0'); // needs root
    expect(r.stdout).not.toContain('IP=0');
    expect(r.stdout).not.toContain('LO=0');
  }, 600_000);

  test('net:none → NO network device at all, so every egress attempt (incl. metadata) fails', async () => {
    const r = await sh(
      'ip -o link | grep -v " lo:" | wc -l; ' +
        'curl -sS --max-time 5 http://1.1.1.1 >/dev/null 2>&1; echo "EXT=$?"; ' +
        'curl -sS --max-time 5 http://169.254.169.254/ >/dev/null 2>&1; echo "META=$?"',
      NET,
      AGENT
    );
    expect(r.stdout.split('\n')[0]?.trim()).toBe('0'); // zero non-loopback NICs
    expect(r.stdout).not.toContain('EXT=0');
    expect(r.stdout).not.toContain('META=0');
  }, 600_000);
});

describe.skipIf(!ENABLED)('net:filtered egress enforcement (direct egress is dropped by nftables)', () => {
  const AGENT = 'agt_filt';
  let ws: string;
  // A proxy port is required by the policy; nothing needs to listen — we only assert that NON-proxy
  // egress is dropped, which is the srt attack surface (direct connect, metadata, DNS, unset-proxy).
  const NET: Policy = { net: { allowProxyPort: 8888 } } as Policy;

  beforeAll(async () => {
    if (!prepared) return;
    ws = await mkdtemp(join(tmpdir(), 'monad-vm-fws-'));
    (NET as { writableRoots?: string[] }).writableRoots = [ws];
  }, 30_000);
  afterAll(async () => {
    await vmLauncher.disposeAgent?.(AGENT);
    if (ws) rmSync(ws, { recursive: true, force: true });
  });

  test('direct TCP to a non-allowlisted host is dropped', async () => {
    const r = await sh('curl -sS --max-time 6 http://1.1.1.1 >/dev/null 2>&1; echo "RC=$?"', NET, AGENT);
    expect(r.stdout).not.toContain('RC=0');
  }, 600_000);

  test('the cloud metadata endpoint 169.254.169.254 is dropped', async () => {
    const r = await sh(
      'curl -sS --max-time 6 http://169.254.169.254/latest/meta-data/ >/dev/null 2>&1; echo "RC=$?"',
      NET,
      AGENT
    );
    expect(r.stdout).not.toContain('RC=0');
  }, 600_000);

  test('unsetting HTTP(S)_PROXY does NOT bypass egress — nftables enforces, not the env var', async () => {
    const r = await sh(
      'unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; curl -sS --max-time 6 http://1.1.1.1 >/dev/null 2>&1; echo "RC=$?"',
      NET,
      AGENT
    );
    expect(r.stdout).not.toContain('RC=0');
  }, 600_000);

  test('DNS/TCP to an arbitrary resolver is dropped (only the gvproxy gateway resolver is allowed)', async () => {
    const r = await sh(
      'timeout 6 sh -c "echo > /dev/udp/8.8.8.8/53" 2>&1; echo "DNS=$?"; ' +
        'timeout 6 sh -c "echo > /dev/tcp/8.8.8.8/443" 2>&1; echo "TCP=$?"',
      NET,
      AGENT
    );
    expect(r.stdout).not.toContain('DNS=0');
    expect(r.stdout).not.toContain('TCP=0');
  }, 600_000);
});

describe.skipIf(!ENABLED)('VM isolation between agents', () => {
  test("one agent's VM cannot see another agent's mounted workspace", async () => {
    if (!prepared) return;
    const wsA = await mkdtemp(join(tmpdir(), 'monad-vm-a-'));
    const wsB = await mkdtemp(join(tmpdir(), 'monad-vm-b-'));
    await writeFile(join(wsB, 'b-secret'), 'AGENT_B_ONLY');
    try {
      // Agent A mounts only wsA; wsB is not mounted in A's VM (separate VM, separate CID, separate clone).
      const r = await sh(
        `cat ${join(wsB, 'b-secret')} 2>&1; ls ${wsB} 2>&1; true`,
        { writableRoots: [wsA], net: 'none' } as Policy,
        'agt_a'
      );
      expect(r.stdout).not.toContain('AGENT_B_ONLY');
    } finally {
      await vmLauncher.disposeAgent?.('agt_a');
      for (const d of [wsA, wsB]) rmSync(d, { recursive: true, force: true });
    }
  }, 600_000);
});
