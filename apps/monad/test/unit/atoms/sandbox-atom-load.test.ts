// End-to-end of the `sandbox` atom kind through the REAL atom-kind-gated loader: the built-in atom
// pack declares `sandbox` and ships the OS launchers; loadChannelAtomPacks must route them to the
// onSandbox sink (the gate would throw if the manifest didn't declare 'sandbox'), and the registry
// must then select the right launcher per platform. Also proves a third-party launcher wins.

import type { SandboxLauncher, WorkspaceExperienceDefinition } from '@monad/sdk-atom';

import { afterEach, expect, test } from 'bun:test';
import builtinAtomPack from '@monad/atoms';
import { defineAtomPack, defineLocalLauncher, SDK_VERSION } from '@monad/sdk-atom';

import { clearSandboxLaunchers, registerSandboxLauncher, selectSandboxLauncher } from '@/capabilities/tools';
import { loadChannelAtomPacks } from '@/channels/atom-pack-host.ts';

afterEach(() => clearSandboxLaunchers());

test('built-in pack registers sandbox launchers through the gated loader', async () => {
  const got: SandboxLauncher[] = [];
  clearSandboxLaunchers();
  await loadChannelAtomPacks([builtinAtomPack], {
    onSandbox: (l) => {
      got.push(l);
      registerSandboxLauncher(l, 'builtin');
    }
  });
  // Seatbelt / bwrap / Landlock / AppContainer / Low-Integrity / Docker / E2B all registered
  // (registration is platform-agnostic; availability is checked at select time).
  expect(got.map((l) => l.kind).sort()).toEqual([
    'appcontainer',
    'bwrap',
    'docker',
    'e2b',
    'landlock',
    'lowintegrity',
    'seatbelt'
  ]);
  // macOS always resolves to Seatbelt (sandbox-exec ships with the OS).
  expect(selectSandboxLauncher('darwin').kind).toBe('seatbelt');
});

test('built-in pack registers workspace experiences through the gated loader', async () => {
  const experiences: WorkspaceExperienceDefinition[] = [];
  await loadChannelAtomPacks([builtinAtomPack], {
    onWorkspaceExperience: (experience) => experiences.push(experience)
  });

  expect(experiences.map((experience) => experience.id)).toEqual(['chat-room', 'graphic-view']);
  expect(experiences.map((experience) => experience.entry.type)).toEqual(['host-component', 'host-component']);
});

test('a discovered sandbox atom pack is preferred over the built-in launcher', async () => {
  clearSandboxLaunchers();
  await loadChannelAtomPacks([builtinAtomPack], {
    onSandbox: (l) => registerSandboxLauncher(l, 'builtin')
  });

  // A minimal third-party pack declaring a `sandbox` launcher for macOS.
  const cloudPack = defineAtomPack({
    manifest: {
      name: 'cloud-sandbox',
      version: '1.0.0',
      sdkVersion: SDK_VERSION,
      atoms: ['sandbox']
    },
    sandboxes: [defineLocalLauncher({ kind: 'cloud', platforms: ['darwin'], wrap: (argv) => argv })]
  });
  await loadChannelAtomPacks([cloudPack], {
    onSandbox: (l) => registerSandboxLauncher(l, 'atom')
  });

  // Third-party (atom) beats the built-in Seatbelt on the same platform.
  expect(selectSandboxLauncher('darwin').kind).toBe('cloud');
});

test('registering a sandbox launcher without declaring the atom kind is rejected', async () => {
  const errors: string[] = [];
  const undeclared = defineAtomPack({
    manifest: { name: 'bad', version: '1.0.0', sdkVersion: SDK_VERSION, atoms: [] },
    sandboxes: [defineLocalLauncher({ kind: 'x', wrap: (argv) => argv })]
  });
  await loadChannelAtomPacks([undeclared], {
    onSandbox: () => {},
    onError: (_pack, err) => errors.push(err instanceof Error ? err.message : String(err))
  });
  expect(errors.some((e) => e.includes('sandbox'))).toBe(true);
});
