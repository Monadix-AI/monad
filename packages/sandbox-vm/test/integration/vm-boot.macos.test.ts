// Real-VM integration + confinement conformance. Boots an actual Fedora CoreOS VM via vfkit and runs
// commands inside it over vsock. Gated: skipped unless MONAD_VM_IT=1 and the base image is present at
// <MONAD_HOME>/vm/images (from a prior run) — a full boot is a ~10GB clone + ~30-60s startup, too
// heavy for the default unit run.
//
// This is the launcher's ADMISSION GATE (docs/proposals/sandbox-package-extraction.md §4): a backend
// that can't prove it denies out-of-root writes, credential reads, unprivileged execution, and
// (net:none) all network does not ship. The cases below are those proofs.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { imagesDir } from '../../src/image.ts';
import { configureVmBackend, vmLauncher } from '../../src/index.ts';
import { configureVmToolchain } from '../../src/toolchain.ts';

// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only gate for the heavy real-VM run
const ENABLED = Bun.env.MONAD_VM_IT === '1' && process.platform === 'darwin';

async function drain(stream: ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (!stream) return '';
  return await new Response(stream).text();
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runInVm(
  argv: string[],
  policy: Parameters<NonNullable<typeof vmLauncher.spawn>>[2],
  sessionId = 'it',
  agentId = 'agt_it'
): Promise<RunResult> {
  if (!vmLauncher.spawn) throw new Error('vm launcher has no spawn');
  const proc = vmLauncher.spawn(argv, { sessionId, agentId }, policy);
  const [stdout, stderr] = await Promise.all([drain(proc.stdout), drain(proc.stderr)]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe.skipIf(!ENABLED)('vm boot + confinement conformance (macOS, real VM)', () => {
  let workspace: string;

  beforeAll(async () => {
    configureVmToolchain({});
    configureVmBackend({ imageConsent: async () => true, idleTtlMs: 5_000 });
    if (!existsSync(imagesDir())) throw new Error(`no base image in ${imagesDir()} — run the image download first`);
    workspace = await mkdtemp(join(tmpdir(), 'monad-vm-it-'));
    await vmLauncher.prepare?.();
  }, 120_000);

  afterAll(async () => {
    await vmLauncher.disposeAgent?.('agt_it');
  });

  test('boots and runs a command, returning stdout + exit 0', async () => {
    const r = await runInVm(['echo', 'hello-from-guest'], { writableRoots: [workspace], net: 'none' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('hello-from-guest');
  }, 120_000);

  test('reuses ONE VM across two sessions of the same agent (no re-boot)', async () => {
    // Marker written by session A must be visible to session B → same VM, same rootfs.
    await runInVm(['sh', '-c', 'echo A > /tmp/marker'], { writableRoots: [workspace], net: 'none' }, 'sesA');
    const r = await runInVm(['cat', '/tmp/marker'], { writableRoots: [workspace], net: 'none' }, 'sesB');
    expect(r.stdout.trim()).toBe('A');
  }, 120_000);

  // ── conformance: the admission proofs ──────────────────────────────────────────────────────────

  test('write OUTSIDE writableRoots is denied (no such mount in the guest)', async () => {
    await runInVm(['sh', '-c', 'echo x > /etc/monad-escape 2>&1; echo done'], {
      writableRoots: [workspace],
      net: 'none'
    });
    // The write fails (read-only /usr, or path absent); the file never appears on the host.
    expect(existsSync('/etc/monad-escape')).toBe(false);
  }, 120_000);

  test('readDenyRoots are not mounted → unreadable in the guest', async () => {
    await writeFile(join(workspace, 'ok.txt'), 'visible');
    const r = await runInVm(['sh', '-c', 'cat ~/.ssh/id_rsa 2>&1; echo EOF'], {
      writableRoots: [workspace],
      readDenyRoots: [join(Bun.env.HOME ?? '', '.ssh')],
      net: 'none'
    });
    // The host's ~/.ssh is never mounted, so the guest can't read it regardless of readDenyRoots.
    expect(r.stdout).not.toContain('PRIVATE KEY');
  }, 120_000);

  test('the workload runs UNPRIVILEGED (no root, no sudo → cannot alter the firewall)', async () => {
    const who = await runInVm(['whoami'], { writableRoots: [workspace], net: 'none' });
    expect(who.stdout.trim()).toBe('monad');
    const sudo = await runInVm(['sh', '-c', 'sudo -n true 2>&1 || echo DENIED'], {
      writableRoots: [workspace],
      net: 'none'
    });
    expect(sudo.stdout).toContain('DENIED');
  }, 120_000);

  test('net:none → NO network device at all (vsock exec is NIC-independent)', async () => {
    // The exec channel is vsock, so net:none drops the NIC entirely: only loopback exists.
    const nics = await runInVm(['sh', '-c', 'ip -o link | grep -v " lo:" | wc -l'], {
      writableRoots: [workspace],
      net: 'none'
    });
    expect(nics.stdout.trim()).toBe('0');
    const egress = await runInVm(['sh', '-c', 'curl -sS --max-time 5 http://1.1.1.1 >/dev/null 2>&1; echo RC=$?'], {
      writableRoots: [workspace],
      net: 'none'
    });
    expect(egress.stdout).not.toContain('RC=0');
  }, 120_000);

  test('net:unrestricted → the guest has a NIC and reaches the internet', async () => {
    const r = await runInVm(['sh', '-c', 'curl -sS --max-time 10 http://1.1.1.1 >/dev/null 2>&1; echo RC=$?'], {
      writableRoots: [workspace],
      net: 'unrestricted'
    });
    expect(r.stdout).toContain('RC=0');
  }, 120_000);
});
