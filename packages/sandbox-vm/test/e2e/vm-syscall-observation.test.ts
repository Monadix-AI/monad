import type { SandboxViolation } from '@monad/sdk-atom';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { realVmAdmission } from './vm-admission.ts';
import {
  disposeRealVm,
  drainBytes,
  drainViolations,
  guestArg,
  guestPath,
  prepareRealVm,
  spawnVm,
  type VmPolicy
} from './vm-fixture.ts';

// biome-ignore lint/suspicious/noUndeclaredEnvVars: explicit real-hypervisor test gate
const ENABLED = realVmAdmission(Bun.env.MONAD_VM_IT) === 'run';
const AGENT = 'agt_syscall_observation';

let root = '';
let writable = '';
let readonly = '';
let outside = '';
let policy: VmPolicy;

beforeAll(async () => {
  if (!ENABLED) return;
  await prepareRealVm();
  root = await mkdtemp(join(tmpdir(), 'monad-vm-observe-'));
  writable = join(root, 'writable');
  readonly = join(root, 'readonly');
  outside = join(root, 'outside-oracle');
  await Promise.all([mkdir(writable), mkdir(readonly)]);
  await Promise.all([Bun.write(join(writable, '.keep'), ''), Bun.write(join(readonly, '.keep'), '')]);
  await writeFile(outside, 'HOST_UNCHANGED');
  policy = { writableRoots: [writable], readableRoots: [readonly], net: 'none' };
}, 120_000);

afterAll(async () => {
  if (!ENABLED) return;
  await disposeRealVm(AGENT);
  if (root) await rm(root, { recursive: true, force: true });
});

async function runObserved(script: string): Promise<SandboxViolation[]> {
  const process = spawnVm(['sh', '-c', script], policy, AGENT);
  const output = Promise.all([drainBytes(process.stdout), drainBytes(process.stderr)]);
  const violations = drainViolations(process.violations);
  await Promise.all([process.exited, output]);
  const events = await violations;
  expect(events.some((event) => event.kind === 'setup' && event.operation === 'seccomp-observer')).toBe(false);
  return events;
}

function hasFilesystemEvent(events: SandboxViolation[], target: string, operations: string[]): boolean {
  const expected = guestPath(target);
  return events.some(
    (event) => event.kind === 'filesystem' && event.target === expected && operations.includes(event.operation)
  );
}

describe.skipIf(!ENABLED)('real guest filesystem syscall observations', () => {
  test('denied openat is reported while the host oracle remains unchanged', async () => {
    const events = await runObserved(`printf pwned > ${guestArg(outside)} 2>/dev/null || true`);

    expect(hasFilesystemEvent(events, outside, ['open', 'openat', 'openat2', 'creat'])).toBe(true);
    expect(await Bun.file(outside).text()).toBe('HOST_UNCHANGED');
  }, 600_000);

  test('rename reports the destination outside writable roots', async () => {
    const target = '/etc/monad-observer-rename';
    const events = await runObserved(
      `printf source >/home/monad/rename-source; mv /home/monad/rename-source ${target} 2>/dev/null || true`
    );

    expect(hasFilesystemEvent(events, target, ['rename', 'renameat', 'renameat2'])).toBe(true);
    expect(existsSync(target)).toBe(false);
  }, 600_000);

  test('a write below a nested no-write mount is reported and denied', async () => {
    const target = join(readonly, 'blocked-write');
    const events = await runObserved(`printf blocked > ${guestArg(target)} 2>/dev/null || true`);

    expect(hasFilesystemEvent(events, target, ['open', 'openat', 'openat2', 'creat'])).toBe(true);
    expect(existsSync(target)).toBe(false);
  }, 600_000);

  test('an allowed writable-root write is suppressed', async () => {
    const target = join(writable, 'allowed-write');
    const events = await runObserved(`printf allowed > ${guestArg(target)}`);

    expect(hasFilesystemEvent(events, target, ['open', 'openat', 'openat2', 'creat'])).toBe(false);
    expect(await Bun.file(target).text()).toBe('allowed');
  }, 600_000);

  test('rapid denied attempts remain bounded and cancellation drains observations', async () => {
    const target = join(root, 'rapid-denied');
    const process = spawnVm(
      ['sh', '-c', `while :; do printf x > ${guestArg(target)} 2>/dev/null; done`],
      policy,
      AGENT,
      { limits: { terminateGraceMs: 500 } }
    );
    const output = Promise.all([drainBytes(process.stdout), drainBytes(process.stderr)]);
    const violations = drainViolations(process.violations);
    await Bun.sleep(250);
    process.kill('SIGTERM');

    await Promise.all([process.exited, output]);
    const events = await violations;
    expect(hasFilesystemEvent(events, target, ['open', 'openat', 'openat2', 'creat'])).toBe(true);
    expect(events.filter((event) => event.kind === 'filesystem').length).toBeLessThanOrEqual(256);
    expect(events.filter((event) => event.operation === 'violation-limit').length).toBeLessThanOrEqual(1);
    expect(events.some((event) => event.kind === 'setup' && event.operation === 'seccomp-observer')).toBe(false);
    expect(existsSync(target)).toBe(false);
  }, 600_000);
});
