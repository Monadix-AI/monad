/// <reference types="bun" />
// biome-ignore-all lint/suspicious/noConsole: standalone smoke CLI — console is the report
// Windows AppContainer launcher smoke test — drives monad-sandbox-appcontainer.exe directly
// (no daemon) to validate confinement, orphan-profile sweep, and ACE lifecycle on a real
// Windows host. Bun runs natively on Windows, so: `bun test/smoke/appcontainer-win32.ts`.
//
// The launcher path is resolved from (in order): argv[2], $MONAD_APPCONTAINER_BIN, or
// ./monad-sandbox-appcontainer.exe next to the cwd. Build it first on the VM (or cross-compile):
//   aarch64-w64-mingw32-clang -O2 -s -municode -o monad-sandbox-appcontainer.exe \
//     apps/monad/native/sandbox-launcher/windows-appcontainer.c -ladvapi32 -luserenv
//
// Validated live on Windows 11 ARM64 (build 26200): native-arch launcher required — an
// x64-emulated launcher cannot start AppContainer children (STATUS_DLL_INIT_FAILED).
//
// Exit code 0 = all sections passed; non-zero = at least one failed (CI-able without a framework).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.platform !== 'win32') {
  console.log('skip: Windows-only smoke test');
  process.exit(0);
}

const BIN =
  process.argv[2] ??
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: smoke-only launcher path override
  process.env.MONAD_APPCONTAINER_BIN ??
  join(process.cwd(), 'monad-sandbox-appcontainer.exe');

if (!existsSync(BIN)) {
  console.error(`launcher not found: ${BIN}\nPass its path as argv[2] or set MONAD_APPCONTAINER_BIN.`);
  process.exit(2);
}

const UNIQ = `monad.smoke${process.pid}`; // unique prefix so we never touch real session profiles
let failures = 0;
const tmps: string[] = [];

function section(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.error(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'mac-smoke-'));
  tmps.push(d);
  return d;
}

/** Run the launcher: [...flags] -- <cmd...>. Returns {code, stdout, stderr}. */
function launch(flags: string[], cmd: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(BIN, [...flags, '--', ...cmd], { encoding: 'utf8', timeout: 30_000 });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** AppContainer profiles whose moniker starts with `prefix`. A profile materializes as a
 *  folder %LOCALAPPDATA%\Packages\<moniker>; the registry "AppContainer\Mappings" key is
 *  absent on modern Windows, so enumerate the Packages folder (matches the launcher's sweep). */
function listProfiles(prefix: string): string[] {
  const ps = `Get-ChildItem "$env:LOCALAPPDATA\\Packages" -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '${prefix}*' } | ForEach-Object { $_.Name }`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  return (r.stdout ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** icacls dump for a path (raw text — we substring-match the AppContainer profile SID/name). */
function icacls(path: string): string {
  const r = spawnSync('icacls', [path], { encoding: 'utf8' });
  return (r.stdout ?? '') + (r.stderr ?? '');
}

console.log(`AppContainer smoke — ${BIN}`);

// ── confinement ────────────────────────────────────────────────────────────
// cmd children pass UNQUOTED paths: mkdtemp paths under TEMP have no spaces, and cmd.exe
// mis-parses the `\"`-escaped inner quotes that the launcher's Raymond-Chen quoting emits.
section('write inside the writable root succeeds', () => {
  const work = mkTmp();
  const r = launch(['--profile', `${UNIQ}w`, '--writable', work], ['cmd', '/c', `echo hi> ${work}\\ok.txt`]);
  launch(['--cleanup-profile', `${UNIQ}w`], []); // best-effort dispose
  assert(existsSync(join(work, 'ok.txt')), `expected ${work}\\ok.txt to exist (code=${r.code}, err=${r.stderr})`);
});

section('write outside the writable root is blocked', () => {
  const work = mkTmp();
  const outside = mkTmp();
  const target = join(outside, 'escape.txt');
  launch(['--profile', `${UNIQ}e`, '--writable', work], ['cmd', '/c', `echo pwned> ${target}`]);
  launch(['--cleanup-profile', `${UNIQ}e`], []);
  assert(!existsSync(target), `escape file should NOT exist: ${target}`);
});

section('reading a deny-read dir is blocked', () => {
  const work = mkTmp();
  const secret = mkTmp();
  writeFileSync(join(secret, 'key.txt'), 'SECRET_TOKEN_VALUE');
  const r = launch(
    ['--profile', `${UNIQ}d`, '--writable', work, '--deny-read', secret],
    ['cmd', '/c', `type ${secret}\\key.txt`]
  );
  launch(['--cleanup-profile', `${UNIQ}d`], []);
  assert(!r.stdout.includes('SECRET_TOKEN_VALUE'), 'deny-read dir leaked secret content');
});

// ── sweep correctness (Packages-folder enumeration; #4 no-skip) ───────────────
section('sweep deletes ALL matching profiles', () => {
  const work = mkTmp();
  const N = 6; // even count — the old delete-while-iterating skipped ~half
  for (let i = 0; i < N; i++) {
    launch(['--profile', `${UNIQ}s${i}`, '--writable', work], ['cmd', '/c', 'exit 0']);
  }
  const before = listProfiles(`${UNIQ}s`);
  assert(before.length === N, `setup: expected ${N} profiles, saw ${before.length} (${before.join(',')})`);

  const r = spawnSync(BIN, ['--sweep-profiles', `${UNIQ}s`], { encoding: 'utf8' });
  assert(r.status === 0, `sweep exited ${r.status}: ${r.stderr}`);

  const after = listProfiles(`${UNIQ}s`);
  assert(after.length === 0, `sweep left ${after.length} profiles behind: ${after.join(',')}`);
});

// ── ACE lifecycle (#2 fallback cleanup, #3 inheritance) ──────────────────────
// The launcher applies grant/deny ACEs before launch and must revert them once the child
// exits — ACEs are scoped to the child's lifetime, not left on the host. Pre-fix the deny
// ACE lingers forever (inherited onto every file under the dir → orphaned-SID DACL bloat).
section('deny-read ACE is reverted after the child exits', () => {
  const work = mkTmp();
  const secret = mkTmp();
  const file = join(secret, 'cred');
  writeFileSync(file, 'x');
  const before = icacls(file);

  launch(['--profile', `${UNIQ}a`, '--writable', work, '--deny-read', secret], ['cmd', '/c', 'exit 0']);
  launch(['--cleanup-profile', `${UNIQ}a`], []);

  // No DENY ACE should remain on the dir or its (inherited) children after the run returns.
  const afterDir = icacls(secret);
  const afterFile = icacls(file);
  assert(!/\(DENY\)|\(N\)/i.test(afterDir), `deny ACE left on dir ${secret}:\n${afterDir}`);
  assert(
    !/\(DENY\)|\(N\)/i.test(afterFile),
    `deny ACE left inherited on ${file} (was clean before:\n${before}\nnow:\n${afterFile})`
  );
});

section('writable-root grant ACE is reverted after the child exits', () => {
  const work = mkTmp();
  launch(['--profile', `${UNIQ}g`, '--writable', work], ['cmd', '/c', 'exit 0']);
  launch(['--cleanup-profile', `${UNIQ}g`], []);
  const after = icacls(work);
  // The AppContainer profile grant shows as an "S-1-15-2-..." capability-SID ACE; none should remain.
  assert(!/S-1-15-2-/i.test(after), `grant ACE left on ${work}:\n${after}`);
});

// ── teardown ─────────────────────────────────────────────────────────────────
for (const p of listProfiles(UNIQ)) spawnSync(BIN, ['--cleanup-profile', p], { encoding: 'utf8' });
for (const d of tmps) {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

console.log(failures === 0 ? '\nPASS' : `\n${failures} section(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
