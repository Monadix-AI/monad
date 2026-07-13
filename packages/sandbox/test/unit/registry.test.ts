import type { SandboxLauncher } from '@monad/sdk-atom';

import { afterEach, expect, test } from 'bun:test';

import {
  clearSandboxLaunchers,
  listSandboxBackendDescriptors,
  registerSandboxLauncher,
  resolveSandboxLauncher
} from '../../src/registry.ts';

function launcher(kind: string, name = kind): SandboxLauncher {
  return {
    kind,
    descriptor: { name, description: `${name} backend` },
    wrap: (argv) => argv
  };
}

afterEach(() => clearSandboxLaunchers({ includeBuiltin: true }));

test('lists built-in auto and source-qualified built-in launchers', () => {
  registerSandboxLauncher(launcher('vm', 'Virtual machine'), { source: 'builtin', kind: 'vm' });

  expect(listSandboxBackendDescriptors().map((entry) => entry.ref)).toEqual([
    { source: 'builtin', kind: 'auto' },
    { source: 'builtin', kind: 'vm' }
  ]);
});

test('keeps duplicate kinds from different packs independently addressable', () => {
  const first = launcher('cloud', 'Cloud A');
  const second = launcher('cloud', 'Cloud B');
  registerSandboxLauncher(first, { source: 'atom-pack', packId: 'vendor-a', kind: 'cloud' });
  registerSandboxLauncher(second, { source: 'atom-pack', packId: 'vendor-b', kind: 'cloud' });

  expect(resolveSandboxLauncher({ source: 'atom-pack', packId: 'vendor-a', kind: 'cloud' })).toBe(first);
  expect(resolveSandboxLauncher({ source: 'atom-pack', packId: 'vendor-b', kind: 'cloud' })).toBe(second);
  expect(listSandboxBackendDescriptors().filter((entry) => entry.ref.kind === 'cloud')).toHaveLength(2);
});

test('rejects duplicate source-qualified identities', () => {
  const ref = { source: 'atom-pack', packId: 'vendor-a', kind: 'cloud' } as const;
  registerSandboxLauncher(launcher('cloud'), ref);

  expect(() => registerSandboxLauncher(launcher('cloud'), ref)).toThrow(
    'sandbox launcher already registered: atom-pack/vendor-a/cloud'
  );
});

test('descriptor listings contain data only and retain trusted pack attribution', () => {
  registerSandboxLauncher(launcher('docker', 'Containers'), {
    source: 'atom-pack',
    packId: 'container-pack',
    kind: 'docker'
  });

  expect(listSandboxBackendDescriptors()).toContainEqual({
    ref: { source: 'atom-pack', packId: 'container-pack', kind: 'docker' },
    descriptor: { name: 'Containers', description: 'Containers backend' },
    platforms: undefined,
    enforces: undefined,
    available: true
  });
  expect(JSON.stringify(listSandboxBackendDescriptors())).not.toContain('wrap');
});

test('rejects executable or unknown contributed field schemas at registration', () => {
  const invalid = {
    kind: 'unsafe',
    descriptor: {
      name: 'Unsafe',
      settings: { fields: [{ id: 'content', type: 'html', label: 'Content' }] }
    },
    wrap: (argv: string[]) => argv
  } as unknown as SandboxLauncher;

  expect(() =>
    registerSandboxLauncher(invalid, { source: 'atom-pack', packId: 'unsafe-pack', kind: 'unsafe' })
  ).toThrow();
});
