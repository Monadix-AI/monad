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
  aliasCanonical = join(writable, 'Canonical Child');
  aliasPath = join(writable, 'Child Junction');
  const aliasDenied = join(aliasCanonical, '.ssh');
  await Promise.all([
    mkdir(denied, { recursive: true }),
    mkdir(readonly, { recursive: true }),
    mkdir(aliasDenied, { recursive: true })
  ]);
  await symlink(aliasCanonical, aliasPath, 'junction');
  await Promise.all([
    writeFile(join(denied, 'id_ed25519'), 'HYPERV_PRIVATE_KEY'),
    writeFile(join(readonly, 'host file'), 'READ_ONLY'),
    writeFile(join(aliasDenied, 'id_ed25519'), 'HYPERV_ALIAS_PRIVATE_KEY')
  ]);
  policy = {
    writableRoots: [writable],
    readableRoots: [readonly, aliasPath],
    readDenyRoots: [denied, join(aliasPath, '.ssh')],
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
}, 120_000);

describe.skipIf(!ENABLED)('real Windows Hyper-V hvsock and 9p confinement', () => {
  test('9p shares preserve spaces, read-only mode, and deny overlays', async () => {
    const written = join(writable, 'guest result');
    const readonlyWrite = join(readonly, 'blocked write');
    const result = await runSh(
      `echo HYPERV_WRITE > ${guestArg(written)}; ` +
        `echo blocked > ${guestArg(readonlyWrite)} 2>/dev/null; echo "RO=$?"; ` +
        `cat ${guestArg(join(denied, 'id_ed25519'))} 2>/dev/null || echo DENIED`,
      policy,
      AGENT
    );

    expect(result.code).toBe(0);
    expect(await Bun.file(written).text()).toBe('HYPERV_WRITE\n');
    expect(existsSync(readonlyWrite)).toBe(false);
    expect(result.stdout).not.toContain('RO=0');
    expect(result.stdout).toContain('DENIED');
    expect(result.stdout).not.toContain('HYPERV_PRIVATE_KEY');
  }, 600_000);

  test('deny overlays cover canonical and junction guest aliases', async () => {
    const result = await runSh(
      `cat ${guestArg(join(aliasCanonical, '.ssh', 'id_ed25519'))} 2>/dev/null || echo CANONICAL_DENIED; ` +
        `cat ${guestArg(join(aliasPath, '.ssh', 'id_ed25519'))} 2>/dev/null || echo ALIAS_DENIED`,
      policy,
      AGENT
    );

    expect(result.stdout).toContain('CANONICAL_DENIED');
    expect(result.stdout).toContain('ALIAS_DENIED');
    expect(result.stdout).not.toContain('HYPERV_ALIAS_PRIVATE_KEY');
  }, 600_000);
});
