// Reload is atomic at the pack boundary: a sweep that cannot complete must leave the previously
// loaded packs serving, not a registry it emptied on the way in.

import type { AtomDescriptor } from '@monad/protocol';
import type { ManifestAtomPack } from '@monad/sdk-atom';
import type { AtomConflict } from '#/atoms/resolve.ts';

import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultConfig } from '@monad/environment';

import { createAtomPackRediscoverer } from '#/atoms/reload.ts';
import { AtomPackRegistry } from '#/handlers/atom-pack/atom-pack-registry.ts';
import { CommandRegistry } from '#/handlers/commands/registry.ts';
import { makeTestPaths } from '../../helpers.ts';

function seededRegistries() {
  const toolRegistry = new AtomPackRegistry();
  toolRegistry.registerWorkplaceExperience(
    {
      id: 'installed-canvas',
      title: 'Installed canvas',
      entry: { type: 'web-component', module: './dist/canvas.js', tagName: 'installed-canvas' }
    },
    'installed-pack',
    ['project.sessions.read']
  );
  const commandRegistry = new CommandRegistry();
  commandRegistry.registerAtom('installed-pack', {
    name: 'ship',
    description: 'Ship it',
    run: async () => ({ text: 'ok' })
  });
  return { commandRegistry, toolRegistry };
}

function rediscovererOver(
  base: string,
  registries: ReturnType<typeof seededRegistries>,
  overrides: {
    configThrows?: boolean;
    reconnectFileMcpThrows?: boolean;
    activeAtomPacks?: Map<string, ManifestAtomPack>;
  } = {}
) {
  const atomConflicts: AtomConflict[] = [];
  const atomDetailsByPack = new Map<string, AtomDescriptor[]>();
  const cfg = createDefaultConfig('Test');
  return createAtomPackRediscoverer({
    paths: makeTestPaths(base),
    config: {
      get: () => {
        if (overrides.configThrows) throw new Error('config unavailable');
        return { cfg, auth: null };
      }
    },
    atomConflicts,
    atomDetailsByPack,
    activeAtomPacks: overrides.activeAtomPacks ?? new Map(),
    commandRegistry: registries.commandRegistry,
    toolRegistry: registries.toolRegistry,
    modelProviderRegistry: { register: () => {} },
    i18nService: { locale: 'en', setPacks: () => {} } as never,
    reconnectFileMcp: async () => {
      if (overrides.reconnectFileMcpThrows) throw new Error('mcp reconnect failed');
    },
    channelService: { setRegistry: () => {} },
    interactions: {} as never
  });
}

test('a sweep that fails before the swap keeps the previously loaded atoms serving', async () => {
  const base = await mkdtemp(join(tmpdir(), 'monad-reload-'));
  const registries = seededRegistries();
  const rediscover = rediscovererOver(base, registries, { configThrows: true });

  try {
    await expect(rediscover()).rejects.toThrow('config unavailable');

    expect([...registries.toolRegistry.workplaceExperiences.keys()]).toEqual(['installed-canvas']);
    expect(registries.commandRegistry.resolve('installed-pack.ship')?.def.name).toBe('ship');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a completed sweep replaces the previous atoms with what it discovered', async () => {
  const base = await mkdtemp(join(tmpdir(), 'monad-reload-swap-'));
  const registries = seededRegistries();
  const rediscover = rediscovererOver(base, registries);

  try {
    await rediscover();

    // The pack dir is empty, so only the built-in pass contributes: the stale third-party
    // registration is gone and the built-in experience is back.
    expect([...registries.toolRegistry.workplaceExperiences.keys()]).toEqual(['chat-room']);
    expect(registries.commandRegistry.resolve('installed-pack.ship')).toBeUndefined();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a post-swap failure still leaves the newly discovered atoms in place', async () => {
  const base = await mkdtemp(join(tmpdir(), 'monad-reload-post-'));
  const registries = seededRegistries();
  const rediscover = rediscovererOver(base, registries, { reconnectFileMcpThrows: true });

  try {
    await expect(rediscover()).rejects.toThrow('mcp reconnect failed');

    expect([...registries.toolRegistry.workplaceExperiences.keys()]).toEqual(['chat-room']);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a pack a sweep drops is deactivated exactly once', async () => {
  const base = await mkdtemp(join(tmpdir(), 'monad-reload-deactivate-'));
  const registries = seededRegistries();
  const teardowns: string[] = [];
  const removedPack: ManifestAtomPack = {
    manifest: { name: 'installed-pack', version: '1.0.0', sdkVersion: '0', atoms: [] },
    register: () => {},
    deactivate: () => {
      teardowns.push('installed-pack');
    }
  };
  const activeAtomPacks = new Map<string, ManifestAtomPack>([['installed-pack', removedPack]]);
  const rediscover = rediscovererOver(base, registries, { activeAtomPacks });

  try {
    // The pack dir is empty, so the sweep discovers nothing and the seeded pack is dropped.
    await rediscover();
    await rediscover();

    expect(teardowns).toEqual(['installed-pack']);
    expect([...activeAtomPacks.keys()]).toEqual([]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a dropped pack's teardown failure does not fail the sweep", async () => {
  const base = await mkdtemp(join(tmpdir(), 'monad-reload-deactivate-throws-'));
  const registries = seededRegistries();
  const activeAtomPacks = new Map<string, ManifestAtomPack>([
    [
      'installed-pack',
      {
        manifest: { name: 'installed-pack', version: '1.0.0', sdkVersion: '0', atoms: [] },
        register: () => {},
        deactivate: () => {
          throw new Error('teardown exploded');
        }
      }
    ]
  ]);
  const rediscover = rediscovererOver(base, registries, { activeAtomPacks });

  try {
    await rediscover();

    expect([...activeAtomPacks.keys()]).toEqual([]);
    expect([...registries.toolRegistry.workplaceExperiences.keys()]).toEqual(['chat-room']);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
