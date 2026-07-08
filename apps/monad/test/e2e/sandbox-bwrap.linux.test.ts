// e2e: daemon-level sandbox wiring for Linux bubblewrap.
//
// Complements apps/monad/test/unit/tools/bwrap.linux.test.ts (raw arg-gen + kernel checks) by
// exercising the full spawn.ts middleware path: the configureSandboxLauncher → sandboxLauncher()
// round-trip, the env overlay in sandboxedSpawn, and kernel-enforced write confinement through
// the daemon's own sandboxedSpawn wrapper rather than the launcher directly.

if (process.platform !== 'linux') process.exit(0);
if (!Bun.which('bwrap')) process.exit(0);

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bwrapLauncher } from '@monad/atoms/sandbox/bwrap';

import {
  clearSandboxLaunchers,
  configureSandboxLauncher,
  noneLauncher,
  registerSandboxLauncher,
  sandboxedSpawn,
  sandboxLauncher,
  selectSandboxLauncher
} from '#/capabilities/tools';

beforeAll(() => configureSandboxLauncher(bwrapLauncher));
afterAll(() => {
  configureSandboxLauncher(noneLauncher);
  clearSandboxLaunchers();
});

test('the launcher registry selects bwrap on Linux when it is the available candidate', () => {
  clearSandboxLaunchers();
  registerSandboxLauncher(bwrapLauncher, 'atom');
  expect(selectSandboxLauncher('linux').kind).toBe('bwrap');
});

test('configureSandboxLauncher is reflected by sandboxLauncher()', () => {
  expect(sandboxLauncher().kind).toBe('bwrap');
});

test('sandboxedSpawn: write inside the writable root succeeds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'monad-e2e-bwrap-'));
  try {
    const target = join(root, 'canary.txt');
    const proc = sandboxedSpawn(
      ['sh', '-c', `echo sandboxed > ${target}`],
      { stdout: 'pipe', stderr: 'pipe' },
      { writableRoots: [root], net: 'unrestricted' }
    );
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(await Bun.file(target).text()).toContain('sandboxed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sandboxedSpawn: write outside the writable root is blocked by the kernel', async () => {
  const root = mkdtempSync(join(tmpdir(), 'monad-e2e-bwrap-'));
  const outside = mkdtempSync(join(tmpdir(), 'monad-e2e-outside-'));
  try {
    const forbidden = join(outside, 'forbidden.txt');
    const proc = sandboxedSpawn(
      ['sh', '-c', `echo leaked > ${forbidden}`],
      { stdout: 'pipe', stderr: 'pipe' },
      { writableRoots: [root], net: 'unrestricted' }
    );
    await proc.exited;
    expect(proc.exitCode).not.toBe(0);
    expect(await Bun.file(forbidden).exists()).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
