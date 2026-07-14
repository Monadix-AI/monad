import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { realVmAdmission } from './vm-admission.ts';
import { disposeRealVm, guestArg, prepareRealVm, runSh, type VmPolicy } from './vm-fixture.ts';

// biome-ignore lint/suspicious/noUndeclaredEnvVars: explicit real-VM test gate
const ENABLED = realVmAdmission(Bun.env.MONAD_VM_IT) === 'run';
const AGENT = 'agt_mount_alias';

let root = '';
let canonical = '';
let alias = '';
let denied = '';
let realCredential = '';
let policy: VmPolicy;

beforeAll(async () => {
  if (!ENABLED) return;
  await prepareRealVm();
  root = await mkdtemp(join(tmpdir(), 'monad-vm-alias-'));
  canonical = join(root, 'canonical-child');
  alias = join(root, 'child-alias');
  denied = join(canonical, '.ssh');
  realCredential = join(canonical, 'credential');
  const fakeStore = join(root, '.mask-store');
  const fakeCredential = join(fakeStore, 'credential');
  await Promise.all([mkdir(denied, { recursive: true }), mkdir(fakeStore, { recursive: true })]);
  await symlink(canonical, alias);
  await Promise.all([
    writeFile(join(denied, 'id_ed25519'), 'ALIAS_PRIVATE_KEY'),
    writeFile(realCredential, 'ALIAS_REAL_CREDENTIAL'),
    writeFile(fakeCredential, 'ALIAS_MASKED')
  ]);
  policy = {
    writableRoots: [root],
    readableRoots: [alias],
    readDenyRoots: [join(alias, '.ssh')],
    maskedFiles: [{ real: join(alias, 'credential'), fake: fakeCredential }],
    net: 'none'
  };
}, 120_000);

afterAll(async () => {
  if (!ENABLED) return;
  await disposeRealVm(AGENT);
  if (root) await rm(root, { recursive: true, force: true });
}, 60_000);

describe.skipIf(!ENABLED)('real VM canonical mount aliases', () => {
  test('deny and mask overlays cover both the canonical path and symlinked guest alias', async () => {
    const result = await runSh(
      `cat ${guestArg(join(canonical, '.ssh', 'id_ed25519'))} 2>/dev/null || echo CANONICAL_DENIED; ` +
        `cat ${guestArg(join(alias, '.ssh', 'id_ed25519'))} 2>/dev/null || echo ALIAS_DENIED; ` +
        `printf 'CANONICAL_MASK='; cat ${guestArg(realCredential)}; ` +
        `printf 'ALIAS_MASK='; cat ${guestArg(join(alias, 'credential'))}`,
      policy,
      AGENT
    );

    expect(result.stdout).toContain('CANONICAL_DENIED');
    expect(result.stdout).toContain('ALIAS_DENIED');
    expect(result.stdout).toContain('CANONICAL_MASK=ALIAS_MASKED');
    expect(result.stdout).toContain('ALIAS_MASK=ALIAS_MASKED');
    expect(result.stdout).not.toContain('ALIAS_PRIVATE_KEY');
    expect(result.stdout).not.toContain('ALIAS_REAL_CREDENTIAL');
  }, 600_000);
});
