// Sandbox launcher registry: the split between the closed LIGHT set (auto) and opt-in HEAVY atom
// launchers (explicit backend). Pure (no spawning), runs on any platform.

import type { SandboxLauncher } from '@monad/sdk-atom';

import { afterEach, expect, test } from 'bun:test';

import {
  clearSandboxLaunchers,
  configureSandboxBackendOptions,
  disposeSandboxSession,
  registerSandboxLauncher,
  sandboxBackendOptions,
  selectSandboxLauncher
} from '#/capabilities/tools';

afterEach(() => clearSandboxLaunchers());

function launcher(kind: string, over: Partial<SandboxLauncher> = {}): SandboxLauncher {
  return { kind, wrap: (argv) => argv, ...over };
}

test('auto selects the light launcher for the platform (macOS → seatbelt)', () => {
  expect(selectSandboxLauncher('darwin', 'auto').kind).toBe('seatbelt');
});

test('auto ignores registered heavy launchers — never auto-selects them', () => {
  registerSandboxLauncher(launcher('docker', { platforms: undefined }), 'atom');
  // Even with docker registered, auto stays on the light OS launcher.
  expect(selectSandboxLauncher('darwin', 'auto').kind).toBe('seatbelt');
});

test('auto falls back to none when no light launcher is a candidate for the platform', () => {
  // On a macOS test host, the Linux light launchers (bwrap/landlock) are not available, so a linux
  // selection has no candidate → none.
  const chosen = selectSandboxLauncher('linux', 'auto');
  if (chosen.kind !== 'none') {
    // A Linux host with bwrap/landlock available resolves to one of them — still not 'none'.
    expect(['bwrap', 'landlock']).toContain(chosen.kind);
  } else {
    expect(chosen.kind).toBe('none');
  }
});

test('explicit backend with no registered heavy launcher falls back to the light default', () => {
  expect(selectSandboxLauncher('darwin', 'docker').kind).toBe('seatbelt');
});

test('explicit backend selects a registered heavy launcher of that kind', () => {
  registerSandboxLauncher(launcher('docker', { platforms: undefined }), 'atom');
  expect(selectSandboxLauncher('darwin', 'docker').kind).toBe('docker');
});

test('explicit backend returns a heavy launcher even when it is currently unavailable', () => {
  // Its prepare()/finalize re-check decides availability; selection must not drop it here.
  registerSandboxLauncher(launcher('docker', { platforms: undefined, isAvailable: () => false }), 'atom');
  expect(selectSandboxLauncher('darwin', 'docker').kind).toBe('docker');
});

test('clearSandboxLaunchers wipes heavy launchers but never the closed light set', () => {
  registerSandboxLauncher(launcher('docker', { platforms: undefined }), 'atom');
  clearSandboxLaunchers();
  // heavy gone → explicit docker falls back to light
  expect(selectSandboxLauncher('darwin', 'docker').kind).toBe('seatbelt');
  // light still present
  expect(selectSandboxLauncher('darwin', 'auto').kind).toBe('seatbelt');
});

test('disposeSandboxSession tells every heavy launcher to release the session', () => {
  const disposed: string[] = [];
  registerSandboxLauncher(
    launcher('e2b', {
      platforms: undefined,
      disposeSession: (s) => {
        disposed.push(s);
      }
    }),
    'atom'
  );
  disposeSandboxSession('sess-9');
  expect(disposed).toEqual(['sess-9']);
});

test('backend options round-trip through the seam', () => {
  configureSandboxBackendOptions({ dockerImage: 'alpine:3.20' });
  expect(sandboxBackendOptions().dockerImage).toBe('alpine:3.20');
  configureSandboxBackendOptions({});
  expect(sandboxBackendOptions().dockerImage).toBeUndefined();
});
