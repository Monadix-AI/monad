import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vmDir } from '../../src/toolchain.ts';
import { realVmAdmission } from './vm-admission.ts';
import { disposeRealVm, guestArg, prepareRealVm, runSh, type VmPolicy } from './vm-fixture.ts';

// biome-ignore lint/suspicious/noUndeclaredEnvVars: explicit real Hyper-V test gate
const ENABLED = realVmAdmission(Bun.env.MONAD_VM_IT) === 'run';
const AGENT = 'agt_hyperv_real';
const BUNDLE_PREFIX = `agt_${AGENT}_`;

let root = '';
let writable = '';
let readonly = '';
let denied = '';
let realCredential = '';
let aliasCanonical = '';
let aliasPath = '';
let policy: VmPolicy;

async function powershell(script: string): Promise<string> {
  const process = Bun.spawn(['powershell', '-NoProfile', '-Command', script], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited
  ]);
  if (code !== 0) throw new Error(`PowerShell cleanup oracle failed: ${stderr.trim()}`);
  return stdout.trim();
}

beforeAll(async () => {
  if (!ENABLED) return;
  await prepareRealVm();
  root = await mkdtemp(join(tmpdir(), 'monad hyperv conformance '));
  writable = join(root, 'Writable Share');
  readonly = join(root, 'Read Only Share');
  denied = join(writable, '.ssh');
  realCredential = join(writable, 'credential file');
  aliasCanonical = join(writable, 'Canonical Child');
  aliasPath = join(writable, 'Child Junction');
  const aliasDenied = join(aliasCanonical, '.ssh');
  const aliasRealCredential = join(aliasCanonical, 'credential');
  const fakeStore = join(writable, '.mask store');
  const fakeCredential = join(fakeStore, 'empty');
  const aliasFakeCredential = join(fakeStore, 'alias empty');
  await Promise.all([
    mkdir(denied, { recursive: true }),
    mkdir(readonly, { recursive: true }),
    mkdir(fakeStore, { recursive: true }),
    mkdir(aliasDenied, { recursive: true })
  ]);
  await symlink(aliasCanonical, aliasPath, 'junction');
  await Promise.all([
    writeFile(join(denied, 'id_ed25519'), 'HYPERV_PRIVATE_KEY'),
    writeFile(join(readonly, 'host file'), 'READ_ONLY'),
    writeFile(realCredential, 'HYPERV_REAL_CREDENTIAL'),
    writeFile(fakeCredential, 'HYPERV_MASKED'),
    writeFile(join(aliasDenied, 'id_ed25519'), 'HYPERV_ALIAS_PRIVATE_KEY'),
    writeFile(aliasRealCredential, 'HYPERV_ALIAS_REAL_CREDENTIAL'),
    writeFile(aliasFakeCredential, 'HYPERV_ALIAS_MASKED')
  ]);
  policy = {
    writableRoots: [writable],
    readableRoots: [readonly, aliasPath],
    readDenyRoots: [denied, join(aliasPath, '.ssh')],
    maskedFiles: [
      { real: realCredential, fake: fakeCredential },
      { real: join(aliasPath, 'credential'), fake: aliasFakeCredential }
    ],
    net: 'none'
  };
}, 120_000);

afterAll(async () => {
  if (!ENABLED) return;
  try {
    await disposeRealVm(AGENT);
    const agentsDir = join(vmDir(), 'agents');
    const bundles = existsSync(agentsDir) ? await readdir(agentsDir) : [];
    expect(bundles.filter((name) => name.startsWith(BUNDLE_PREFIX))).toEqual([]);
    expect(await powershell(`@(Get-VM -Name 'monad-${BUNDLE_PREFIX}*' -ErrorAction SilentlyContinue).Count`)).toBe('0');
    expect(
      await powershell(
        `@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*monad-vm-${BUNDLE_PREFIX}*' }).Count`
      )
    ).toBe('0');
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe.skipIf(!ENABLED)('real Windows Hyper-V hvsock and 9p confinement', () => {
  test('9p shares preserve spaces, read-only mode, deny overlays, and credential masks', async () => {
    const written = join(writable, 'guest result');
    const readonlyWrite = join(readonly, 'blocked write');
    const result = await runSh(
      `echo HYPERV_WRITE > ${guestArg(written)}; ` +
        `echo blocked > ${guestArg(readonlyWrite)} 2>/dev/null; echo "RO=$?"; ` +
        `cat ${guestArg(join(denied, 'id_ed25519'))} 2>/dev/null || echo DENIED; ` +
        `printf 'MASK='; cat ${guestArg(realCredential)}`,
      policy,
      AGENT
    );

    expect(result.code).toBe(0);
    expect(await Bun.file(written).text()).toBe('HYPERV_WRITE\n');
    expect(existsSync(readonlyWrite)).toBe(false);
    expect(result.stdout).not.toContain('RO=0');
    expect(result.stdout).toContain('DENIED');
    expect(result.stdout).toContain('MASK=HYPERV_MASKED');
    expect(result.stdout).not.toContain('HYPERV_PRIVATE_KEY');
    expect(result.stdout).not.toContain('HYPERV_REAL_CREDENTIAL');
  }, 600_000);

  test('deny and mask overlays cover canonical and junction guest aliases', async () => {
    const result = await runSh(
      `cat ${guestArg(join(aliasCanonical, '.ssh', 'id_ed25519'))} 2>/dev/null || echo CANONICAL_DENIED; ` +
        `cat ${guestArg(join(aliasPath, '.ssh', 'id_ed25519'))} 2>/dev/null || echo ALIAS_DENIED; ` +
        `printf 'CANONICAL_MASK='; cat ${guestArg(join(aliasCanonical, 'credential'))}; ` +
        `printf 'ALIAS_MASK='; cat ${guestArg(join(aliasPath, 'credential'))}`,
      policy,
      AGENT
    );

    expect(result.stdout).toContain('CANONICAL_DENIED');
    expect(result.stdout).toContain('ALIAS_DENIED');
    expect(result.stdout).toContain('CANONICAL_MASK=HYPERV_ALIAS_MASKED');
    expect(result.stdout).toContain('ALIAS_MASK=HYPERV_ALIAS_MASKED');
    expect(result.stdout).not.toContain('HYPERV_ALIAS_PRIVATE_KEY');
    expect(result.stdout).not.toContain('HYPERV_ALIAS_REAL_CREDENTIAL');
  }, 600_000);
});
