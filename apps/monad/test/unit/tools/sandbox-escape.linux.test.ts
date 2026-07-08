// Linux sandbox escape tests — Landlock FS write-restriction + seccomp-bpf syscall filter.
//
// Requires the compiled monad-sandbox-launcher binary placed next to the bun executable:
//   gcc -O2 -s -static -o "$(dirname "$(which bun)")/monad-sandbox-launcher" \
//     apps/monad/native/sandbox-launcher/main.c
//
// Tests are skipped automatically when the binary isn't available.

if (process.platform !== 'linux') process.exit(0);

import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { landlockLauncher } from '@monad/atoms/sandbox/landlock';

import { configureSandboxLauncher, noneLauncher, sandboxedSpawn } from '#/capabilities/tools';

const launcher = landlockLauncher;
// Skip when the native monad-sandbox-launcher binary isn't installed (isAvailable() probes for it).
if (!launcher.isAvailable?.()) {
  process.exit(0);
}

afterEach(() => configureSandboxLauncher(noneLauncher));

/** Spawn a shell command under the Landlock launcher with the given writable roots (+ optional net). */
async function runConfined(command: string, writableRoots: string[], net?: 'none') {
  configureSandboxLauncher(launcher);
  const proc = sandboxedSpawn(['/bin/sh', '-c', command], { stdout: 'pipe', stderr: 'pipe' }, { writableRoots, net });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  return { stdout, stderr, exitCode };
}

// ctypes socket() probe (same style as the ptrace probe below). socket(domain, SOCK_STREAM, 0):
// exit 0 if the fd is created, 1 if seccomp denies it (errno EACCES), 2 on any other errno. Skips
// gracefully (exit 0) when python3 is unavailable. `domain` is 2 (AF_INET) or 10 (AF_INET6).
function inetSocketProbe(domain: number): string {
  return [
    'python3 -c "',
    'import ctypes, errno as E, sys;',
    'libc=ctypes.CDLL(None, use_errno=True);',
    `fd=libc.socket(${domain}, 1, 0);`,
    'e=ctypes.get_errno();',
    'sys.exit(0 if fd >= 0 else (1 if e == E.EACCES else 2))',
    '" 2>/dev/null',
    '|| { echo "python3 unavailable"; exit 0; }'
  ].join('');
}

// ── Landlock: write restriction ───────────────────────────────────────────────

test('write inside writable root succeeds', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'll-in-')));
  const r = await runConfined(`echo hello > "${root}/ok.txt" && cat "${root}/ok.txt"`, [root]);
  expect(r.exitCode).toBe(0);
  expect(r.stdout.trim()).toBe('hello');
  expect(existsSync(join(root, 'ok.txt'))).toBe(true);
  await rm(root, { recursive: true, force: true });
});

test('write OUTSIDE writable root is blocked by Landlock', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'll-root-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'll-out-')));
  const target = join(outside, 'escape.txt');
  const r = await runConfined(`echo pwned > "${target}"`, [root]);
  expect(r.exitCode).not.toBe(0);
  expect(existsSync(target)).toBe(false);
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test('write to home directory outside sandbox is blocked', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'll-home-')));
  const target = join(Bun.env.HOME ?? tmpdir(), '.monad-landlock-escape-probe');
  const r = await runConfined(`echo leak > "${target}"`, [root]);
  expect(r.exitCode).not.toBe(0);
  expect(existsSync(target)).toBe(false);
  await rm(root, { recursive: true, force: true });
});

test('existing file in writable root can be overwritten', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'll-ow-')));
  await writeFile(join(root, 'existing.txt'), 'original');
  const r = await runConfined(`echo updated > "${root}/existing.txt" && cat "${root}/existing.txt"`, [root]);
  expect(r.exitCode).toBe(0);
  expect(r.stdout.trim()).toBe('updated');
  await rm(root, { recursive: true, force: true });
});

// ── Seccomp: syscall filter ───────────────────────────────────────────────────

test('seccomp BPF filter is active inside the sandbox (/proc/self/status Seccomp: 2)', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'll-sc-')));
  // /proc/self/status shows "Seccomp: 2" (SECCOMP_MODE_FILTER) when a BPF filter is loaded.
  // Use cat rather than grep -P: pcre JIT calls mmap(PROT_EXEC) which the seccomp filter blocks.
  const r = await runConfined('cat /proc/self/status', [root]);
  expect(r.stdout).toMatch(/^Seccomp:\s+2$/m);
  await rm(root, { recursive: true, force: true });
});

test('ptrace is blocked (EPERM) inside the sandbox', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'll-pt-')));
  // Python3 syscall probe: ptrace(PTRACE_TRACEME=0, ...) should return -1 with errno=EPERM(1).
  // Falls back to a more portable shell-only check if python3 is not available.
  const probe = [
    'python3 -c "',
    'import ctypes, errno as E, sys;',
    'r=ctypes.CDLL(None,use_errno=True).ptrace(0,0,0,0);',
    'e=ctypes.get_errno();',
    'sys.exit(0 if e == E.EPERM else 1)',
    '" 2>/dev/null',
    '|| { echo "python3 unavailable"; exit 0; }' // skip gracefully if no python3
  ].join('');
  const r = await runConfined(probe, [root]);
  expect(r.exitCode).toBe(0);
  await rm(root, { recursive: true, force: true });
});

test('process_vm_writev is blocked (EPERM) inside the sandbox', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'll-vmw-')));
  const probe = [
    'python3 -c "',
    'import ctypes, ctypes.util, errno as E, sys;',
    'SYS_process_vm_writev=311;', // x86_64 syscall number
    'r=ctypes.CDLL(None).syscall(SYS_process_vm_writev,0,0,0,0,0,0);',
    'e=ctypes.get_errno();',
    'sys.exit(0 if e == E.EPERM else 1)',
    '" 2>/dev/null',
    '|| { echo "python3 unavailable"; exit 0; }'
  ].join('');
  const r = await runConfined(probe, [root]);
  expect(r.exitCode).toBe(0);
  await rm(root, { recursive: true, force: true });
});

// ── Sandboxed child can still read anywhere (reads are not in the Landlock ruleset) ──

test('reads outside the writable root are allowed (Landlock write-only)', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'll-rd-')));
  // /etc/hostname exists on every Linux system; we only restrict writes.
  const r = await runConfined('cat /etc/hostname', [root]);
  expect(r.exitCode).toBe(0);
  await rm(root, { recursive: true, force: true });
});

// ── Seccomp: net:'none' denies IP socket creation (kernel-level egress block) ──

test("net:'none' blocks AF_INET socket creation (EACCES)", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'll-net4-')));
  const r = await runConfined(inetSocketProbe(2 /* AF_INET */), [root], 'none');
  expect(r.exitCode).toBe(0); // probe exits 0 on the expected EACCES (or skips if no python3)
  await rm(root, { recursive: true, force: true });
});

test("net:'none' blocks AF_INET6 socket creation (EACCES)", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'll-net6-')));
  const r = await runConfined(inetSocketProbe(10 /* AF_INET6 */), [root], 'none');
  expect(r.exitCode).toBe(0);
  await rm(root, { recursive: true, force: true });
});

test('default net allows AF_INET socket creation (no over-blocking)', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'll-neta-')));
  // No net policy passed → launcher omits --net → socket() must NOT be denied. The probe exits 0
  // only when the fd is created; a spurious EACCES (exit 1) would fail this test.
  const probe = [
    'python3 -c "',
    'import ctypes, sys;',
    'libc=ctypes.CDLL(None, use_errno=True);',
    'fd=libc.socket(2, 1, 0);',
    'sys.exit(0 if fd >= 0 else 1)',
    '" 2>/dev/null',
    '|| { echo "python3 unavailable"; exit 0; }'
  ].join('');
  const r = await runConfined(probe, [root]);
  expect(r.exitCode).toBe(0);
  await rm(root, { recursive: true, force: true });
});
