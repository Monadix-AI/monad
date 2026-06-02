// Sandbox launcher registry: platform filtering, availability gating, third-party-over-built-in
// precedence, and the noneLauncher fallback. Pure (no spawning), runs on any platform.

import type { SandboxLauncher } from '@monad/sdk-atom';

import { afterEach, expect, test } from 'bun:test';

import {
  clearSandboxLaunchers,
  disposeSandboxSession,
  registerSandboxLauncher,
  selectSandboxLauncher
} from '@/capabilities/tools';

afterEach(() => clearSandboxLaunchers());

function launcher(kind: string, over: Partial<SandboxLauncher> = {}): SandboxLauncher {
  return { kind, wrap: (argv) => argv, ...over };
}

test('empty registry falls back to noneLauncher', () => {
  expect(selectSandboxLauncher('linux').kind).toBe('none');
});

test('selects the launcher matching the platform', () => {
  registerSandboxLauncher(launcher('seatbelt', { platforms: ['darwin'] }), 'builtin');
  registerSandboxLauncher(launcher('landlock', { platforms: ['linux'] }), 'builtin');
  expect(selectSandboxLauncher('darwin').kind).toBe('seatbelt');
  expect(selectSandboxLauncher('linux').kind).toBe('landlock');
});

test('platforms undefined matches any platform (e.g. a cloud launcher)', () => {
  registerSandboxLauncher(launcher('e2b', { platforms: undefined }), 'atom');
  expect(selectSandboxLauncher('win32').kind).toBe('e2b');
});

test('an unavailable launcher is skipped', () => {
  registerSandboxLauncher(launcher('landlock', { platforms: ['linux'], isAvailable: () => false }), 'builtin');
  // No other candidate → none.
  expect(selectSandboxLauncher('linux').kind).toBe('none');
});

test('a third-party (atom) launcher is preferred over a built-in on the same platform', () => {
  registerSandboxLauncher(launcher('seatbelt', { platforms: ['darwin'] }), 'builtin');
  registerSandboxLauncher(launcher('cloud', { platforms: ['darwin'] }), 'atom');
  expect(selectSandboxLauncher('darwin').kind).toBe('cloud');
});

test('with two atom launchers for one platform, the first registered wins (loser shadowed)', () => {
  registerSandboxLauncher(launcher('cloud-a', { platforms: ['darwin'] }), 'atom');
  registerSandboxLauncher(launcher('cloud-b', { platforms: ['darwin'] }), 'atom');
  expect(selectSandboxLauncher('darwin').kind).toBe('cloud-a');
});

test('falls back to a built-in when the only atom launcher is unavailable', () => {
  registerSandboxLauncher(launcher('seatbelt', { platforms: ['darwin'] }), 'builtin');
  registerSandboxLauncher(launcher('cloud', { platforms: ['darwin'], isAvailable: () => false }), 'atom');
  expect(selectSandboxLauncher('darwin').kind).toBe('seatbelt');
});

test('disposeSandboxSession tells every launcher to release the session', () => {
  const disposed: string[] = [];
  registerSandboxLauncher(
    launcher('cloud', {
      disposeSession: (s) => {
        disposed.push(s);
      }
    }),
    'atom'
  );
  registerSandboxLauncher(launcher('seatbelt', { platforms: ['darwin'] }), 'builtin'); // no disposeSession → no-op
  disposeSandboxSession('sess-9');
  expect(disposed).toEqual(['sess-9']);
});

test('clearSandboxLaunchers empties the registry', () => {
  registerSandboxLauncher(launcher('seatbelt', { platforms: ['darwin'] }), 'builtin');
  clearSandboxLaunchers();
  expect(selectSandboxLauncher('darwin').kind).toBe('none');
});
