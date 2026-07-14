// Real-VM confinement conformance — adversarial, modeled on @anthropic-ai/sandbox-runtime's attack
// tests. Boots an actual Fedora CoreOS VM (vfkit, QEMU/KVM, or Hyper-V) and tries to ESCAPE it, then
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
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { realVmAdmission } from './vm-admission.ts';
import {
  disposeRealVm,
  drainBytes as drain,
  guestArg,
  type VmPolicy as Policy,
  prepareRealVm,
  runSh as sh,
  spawnVm as spawn,
  waitForHostFile
} from './vm-fixture.ts';

// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only gate for the heavy real-VM run
const ENABLED = realVmAdmission(Bun.env.MONAD_VM_IT) === 'run';

let prepared = false;
beforeAll(async () => {
  if (!ENABLED) return;
  await prepareRealVm();
  prepared = true;
}, 120_000);

describe.skipIf(!ENABLED)('net:none confinement (fs escape, credential, privilege)', () => {
  const AGENT = 'agt_none';
  let ws: string; // writable mount
  let ro: string; // readonly mount
  let hostSecretOutside: string; // a host file NOT mounted — the escape oracle
  let deniedDir: string;
  let maskedCredential: string;
  const NET: Policy = {} as Policy;

  beforeAll(async () => {
    if (!prepared) return;
    ws = await mkdtemp(join(tmpdir(), 'monad-vm-ws-'));
    ro = await mkdtemp(join(tmpdir(), 'monad-vm-ro-'));
    hostSecretOutside = join(mkdtempSync(join(tmpdir(), 'monad-vm-secret-')), 'host-secret');
    writeFileSync(hostSecretOutside, 'HOST_SECRET_NEVER_REACHABLE');
    deniedDir = join(ws, '.ssh');
    maskedCredential = join(ws, '.credentials');
    const fakeStore = join(ws, '.monad-mask-store');
    await Promise.all([mkdir(deniedDir, { recursive: true }), mkdir(fakeStore, { recursive: true })]);
    await writeFile(join(deniedDir, 'id_ed25519'), 'PRIVATE_KEY_NEVER_REACHABLE');
    await writeFile(maskedCredential, 'REAL_CREDENTIAL_NEVER_REACHABLE');
    const fakeCredential = join(fakeStore, 'empty');
    await writeFile(fakeCredential, 'MASKED');
    Object.assign(NET, {
      writableRoots: [ws],
      readableRoots: [ro],
      readDenyRoots: [deniedDir],
      maskedFiles: [{ real: maskedCredential, fake: fakeCredential }],
      net: 'none'
    });
  }, 30_000);

  afterAll(async () => {
    await disposeRealVm(AGENT);
    for (const d of [ws, ro]) if (d) rmSync(d, { recursive: true, force: true });
  });

  test('boots and runs a command unprivileged (uid 1001, no wheel → no sudo)', async () => {
    const r = await sh('echo OK; id -u; whoami; sudo -n true 2>&1 || echo NOSUDO', NET, AGENT);
    expect(r.stdout).toContain('OK');
    expect(r.stdout).toContain('1001');
    expect(r.stdout).toContain('monad');
    expect(r.stdout).toContain('NOSUDO');
  }, 600_000);

  test('interactive runs have a real PTY with resize and merged output', async () => {
    const proc = spawn(
      ['sh', '-c', "stty -echo; read line; stty size; printf 'LINE=%s\\n' \"$line\"; printf 'STDERR-MERGED\\n' >&2"],
      NET,
      AGENT,
      { terminal: { cols: 90, rows: 31 } }
    );
    const stdout = drain(proc.stdout);

    expect(proc.stderr).toBeUndefined();
    expect(proc.terminal).toBeDefined();
    await proc.terminal?.resize(132, 44);
    await proc.terminal?.write('hello-pty\n');

    expect(await proc.exited).toBe(0);
    expect(await stdout).toContain('44 132');
    expect(await stdout).toContain('LINE=hello-pty');
    expect(await stdout).toContain('STDERR-MERGED');
  }, 600_000);

  test('guest overlays hide denied paths and replace masked files', async () => {
    const r = await sh(
      `cat ${guestArg(join(deniedDir, 'id_ed25519'))} 2>/dev/null || echo DENIED; ` +
        `printf 'MASK='; cat ${guestArg(maskedCredential)}`,
      NET,
      AGENT
    );

    expect(r.stdout).toContain('DENIED');
    expect(r.stdout).toContain('MASK=MASKED');
    expect(r.stdout).not.toContain('PRIVATE_KEY_NEVER_REACHABLE');
    expect(r.stdout).not.toContain('REAL_CREDENTIAL_NEVER_REACHABLE');
  }, 600_000);

  test('write OUTSIDE any mount stays in the guest namespace — the host escape target is untouched', async () => {
    await sh(
      `echo pwned > ${guestArg(hostSecretOutside)} 2>/dev/null; echo x > /etc/monad-escape 2>/dev/null; true`,
      NET,
      AGENT
    );
    expect(existsSync('/etc/monad-escape')).toBe(false); // the test host's /etc
    expect(await Bun.file(hostSecretOutside).text()).toBe('HOST_SECRET_NEVER_REACHABLE');
  }, 600_000);

  test('symlink escape: a link in the writable mount → host path does NOT grant host write', async () => {
    // srt's highest-value port: symlink inside an allowed dir pointing outside, then write through it.
    // In a VM the link resolves in the guest namespace, so the host target is never reached.
    await sh(
      `ln -sf ${guestArg(hostSecretOutside)} ${guestArg(join(ws, 'escape-link'))}; ` +
        `echo pwned > ${guestArg(join(ws, 'escape-link'))} 2>/dev/null; ` +
        `ln -sf /etc ${guestArg(join(ws, 'etc-link'))}; ` +
        `echo pwned > ${guestArg(join(ws, 'etc-link', 'monad-escape2'))} 2>/dev/null; true`,
      NET,
      AGENT
    );
    expect(await Bun.file(hostSecretOutside).text()).toBe('HOST_SECRET_NEVER_REACHABLE');
    expect(existsSync('/etc/monad-escape2')).toBe(false);
  }, 600_000);

  test('write to a READONLY mount fails (ro virtio-fs), directly and via a symlink into it', async () => {
    const r = await sh(
      `echo direct > ${guestArg(join(ro, 'ro-write'))} 2>&1; echo "RC=$?"; ` +
        `ln -sf ${guestArg(ro)} ${guestArg(join(ws, 'ro-link'))}; ` +
        `echo viaLink > ${guestArg(join(ws, 'ro-link', 'x'))} 2>&1; echo "RC2=$?"`,
      NET,
      AGENT
    );
    expect(r.stdout).not.toContain('RC=0');
    expect(r.stdout).not.toContain('RC2=0');
    expect(existsSync(join(ro, 'ro-write'))).toBe(false);
    expect(existsSync(join(ro, 'x'))).toBe(false);
  }, 600_000);

  test('a path NOT mounted (host credential file) is absent in the guest', async () => {
    const r = await sh(
      `cat ${guestArg(hostSecretOutside)} 2>&1; ls -la ${guestArg(hostSecretOutside)} 2>&1; true`,
      NET,
      AGENT
    );
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

  test('cancellation terminates the workload and its descendants before they can mutate the host mount', async () => {
    const ready = join(ws, 'cancel-ready');
    const survived = join(ws, 'descendant-survived');
    const proc = spawn(
      ['sh', '-c', `touch ${guestArg(ready)}; (sleep 2; echo survived > ${guestArg(survived)}) & wait`],
      NET,
      AGENT,
      { limits: { terminateGraceMs: 500 } }
    );
    const output = Promise.all([drain(proc.stdout), drain(proc.stderr)]);
    await waitForHostFile(ready);

    proc.kill('SIGTERM');

    expect(await proc.exit).toEqual({ code: null, signal: 15 });
    await output;
    await Bun.sleep(2500);
    expect(existsSync(survived)).toBe(false);
  }, 600_000);

  test('each run has a fresh PID namespace and private tmpfs', async () => {
    const firstPid = await sh('echo $$; echo secret >/tmp/only-first-run', NET, AGENT);
    const second = await sh('echo $$; test ! -e /tmp/only-first-run; echo "TMP=$?"', NET, AGENT);

    expect(firstPid.stdout.trim()).toBe('2');
    expect(second.stdout).toContain('2\n');
    expect(second.stdout).toContain('TMP=0');
  }, 600_000);

  test('per-run pids cgroup applies the requested process ceiling', async () => {
    const proc = spawn(
      ['sh', '-c', `cg=$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup); cat /sys/fs/cgroup"$cg"/pids.max`],
      NET,
      AGENT,
      { limits: { maxProcesses: 8 } }
    );

    expect((await drain(proc.stdout)).trim()).toBe('8');
    expect(await proc.exited).toBe(0);
  }, 600_000);

  test('a containment-relevant policy change boots a VM with the new mount identity', async () => {
    const alternate = await mkdtemp(join(tmpdir(), 'monad-vm-policy-'));
    try {
      const target = join(alternate, 'new-policy-visible');
      await sh(`echo visible > ${guestArg(target)}`, { writableRoots: [alternate], net: 'none' } as Policy, AGENT);
      expect(await Bun.file(target).text()).toBe('visible\n');
    } finally {
      rmSync(alternate, { recursive: true, force: true });
    }
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
    await disposeRealVm(AGENT);
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
        `cat ${guestArg(join(wsB, 'b-secret'))} 2>&1; ls ${guestArg(wsB)} 2>&1; true`,
        { writableRoots: [wsA], net: 'none' } as Policy,
        'agt_a'
      );
      expect(r.stdout).not.toContain('AGENT_B_ONLY');
    } finally {
      await disposeRealVm('agt_a');
      for (const d of [wsA, wsB]) rmSync(d, { recursive: true, force: true });
    }
  }, 600_000);
});
