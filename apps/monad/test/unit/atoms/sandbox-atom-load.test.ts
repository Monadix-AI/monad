// The `sandbox` atom kind through the REAL atom-kind-gated loader. Sandbox launchers split in two:
// the LIGHT OS launchers are a CLOSED internal set of @monad/sandbox (not atoms, always present), and
// the HEAVY docker/e2b launchers are the opt-in @monad/monad-power-pack atom pack. So the built-in
// @monad/atoms pack NO LONGER declares `sandbox` — it registers no launchers. A heavy atom pack that
// DOES declare `sandbox` routes its launchers through the onSandbox sink and is selectable by kind.

import type { SandboxLauncher, WorkspaceExperienceDefinition } from '@monad/sdk-atom';

import { afterEach, expect, test } from 'bun:test';
import builtinAtomPack from '@monad/atoms';
import { monadPowerPack } from '@monad/monad-power-pack';
import { vmLauncher } from '@monad/sandbox-vm';
import { defineAtomPack, defineLocalLauncher, SDK_VERSION } from '@monad/sdk-atom';

import { clearSandboxLaunchers, registerSandboxLauncher, selectSandboxLauncher } from '#/capabilities/tools';
import { loadChannelAtomPacks } from '#/channels/atom-pack-host.ts';

afterEach(() => clearSandboxLaunchers({ includeBuiltin: true }));

test('built-in pack registers no sandbox launchers (light set is closed, heavy is opt-in)', async () => {
  const got: SandboxLauncher[] = [];
  clearSandboxLaunchers();
  await loadChannelAtomPacks([builtinAtomPack], {
    onSandbox: (l) => {
      got.push(l);
      registerSandboxLauncher(l, { source: 'builtin', kind: l.kind });
    }
  });
  expect(got).toEqual([]);
  // The light OS launcher is still selected on auto — it comes from the closed internal set, not the
  // atom registry. macOS always resolves to Seatbelt (sandbox-exec ships with the OS).
  expect(selectSandboxLauncher('darwin', 'auto').kind).toBe('seatbelt');
});

test('the power pack registers only contributed heavy launchers through the gated loader', async () => {
  const got: SandboxLauncher[] = [];
  const experiences: WorkspaceExperienceDefinition[] = [];
  clearSandboxLaunchers();
  await loadChannelAtomPacks([monadPowerPack], {
    onSandbox: (l, atomPackId) => {
      got.push(l);
      registerSandboxLauncher(l, { source: 'atom-pack', packId: atomPackId, kind: l.kind });
    },
    onWorkspaceExperience: (experience) => experiences.push(experience)
  });
  expect(got.map((l) => l.kind).sort()).toEqual(['docker', 'e2b']);
  expect(got.find((launcher) => launcher.kind === 'docker')?.descriptor.settings?.fields[0]?.type).toBe('string');
  expect(got.find((launcher) => launcher.kind === 'e2b')?.descriptor.settings?.fields[0]?.type).toBe('secret');
  // Explicit backend selects the registered heavy launcher even when the light default differs.
  expect(selectSandboxLauncher('darwin', 'e2b').kind).toBe('e2b');
  expect(experiences).toEqual([
    {
      id: 'kanban',
      title: 'Kanban',
      icon: 'git-fork',
      entry: {
        type: 'web-component',
        module: 'experiences/kanban.js',
        tagName: 'monad-kanban'
      }
    }
  ]);
});

test('the power pack still exposes sandbox details when a runtime sink rejects registration', async () => {
  const described: string[] = [];
  await loadChannelAtomPacks([monadPowerPack], {
    onSandbox: () => {
      throw new Error('runtime registry unavailable');
    },
    onAtoms: (_pack, atoms) => described.push(...atoms.map((atom) => `${atom.kind}:${atom.id}`)),
    onError: () => {}
  });

  expect(described).toEqual(['sandbox:docker', 'sandbox:e2b', 'workspace-experience:kanban']);
});

test('vm remains available as a built-in without loading Power Pack', () => {
  registerSandboxLauncher(vmLauncher, { source: 'builtin', kind: 'vm' });
  expect(selectSandboxLauncher('darwin', { source: 'builtin', kind: 'vm' })).toBe(vmLauncher);
  expect(vmLauncher.descriptor.settings?.fields.map((field) => field.id)).toEqual([
    'cpus',
    'memoryMiB',
    'bootTimeoutMs'
  ]);
});

test('built-in pack registers workspace experiences through the gated loader', async () => {
  const experiences: WorkspaceExperienceDefinition[] = [];
  await loadChannelAtomPacks([builtinAtomPack], {
    onWorkspaceExperience: (experience) => experiences.push(experience)
  });

  expect(experiences.map((experience) => experience.id)).toEqual(['chat-room']);
  expect(experiences.map((experience) => experience.entry.type)).toEqual(['host-component']);
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
  expect(errors.length).toBeGreaterThan(0);
});
