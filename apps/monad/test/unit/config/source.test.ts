import type { MonadConfig, MonadPaths } from '@monad/environment';
import type { HomeConfigIo } from '#/config/source.ts';

import { expect, test } from 'bun:test';
import { createDefaultConfig, emptyAuth } from '@monad/environment';

import { createHomeConfigSource } from '#/config/source.ts';

const paths = {
  auth: '/home/auth.json',
  config: '/home/config.json',
  agentsConfig: '/home/agents.json',
  mesh: '/home/mesh.json'
} satisfies Pick<MonadPaths, 'auth' | 'config' | 'agentsConfig' | 'mesh'>;

function config(): MonadConfig {
  return createDefaultConfig('Test');
}

function io(overrides: Partial<HomeConfigIo> = {}): HomeConfigIo {
  return {
    loadAuth: async () => emptyAuth(),
    loadConfig: async () => config(),
    saveAuth: async () => {},
    saveConfig: async () => {},
    ...overrides
  };
}

test('loads config and auth as one snapshot from canonical paths', async () => {
  const cfg = config();
  const auth = emptyAuth();
  const reads: string[] = [];
  const source = createHomeConfigSource(paths, {
    io: io({
      loadConfig: async (configPaths) => {
        reads.push(`config:${configPaths.config}:${configPaths.agentsConfig}:${configPaths.mesh}`);
        return cfg;
      },
      loadAuth: async (authPath) => {
        reads.push(`auth:${authPath}`);
        return auth;
      }
    })
  });

  const loaded = await source.load();

  expect(loaded).toEqual({ auth, cfg });
  expect(reads.sort()).toEqual([`auth:${paths.auth}`, `config:${paths.config}:${paths.agentsConfig}:${paths.mesh}`]);
});

test('returns null when the config input is unavailable', async () => {
  const source = createHomeConfigSource(paths, { io: io({ loadConfig: async () => null }) });

  expect(await source.load()).toBeNull();
});

test('delegates config and auth writes to canonical paths', async () => {
  const cfg = config();
  const auth = emptyAuth();
  const writes: string[] = [];
  const source = createHomeConfigSource(paths, {
    io: io({
      saveConfig: async (configPaths, value) =>
        void writes.push(
          `config:${configPaths.config}:${configPaths.agentsConfig}:${configPaths.mesh}:${value.user.displayName}`
        ),
      saveAuth: async (path, value) => void writes.push(`auth:${path}:${value.version}`)
    })
  });

  await source.saveConfig(cfg);
  await source.saveAuth(auth);

  expect(writes).toEqual([
    `config:${paths.config}:${paths.agentsConfig}:${paths.mesh}:${cfg.user.displayName}`,
    `auth:${paths.auth}:${auth.version}`
  ]);
});

test('passes watcher events and unsubscribe through unchanged', () => {
  const events: string[] = [];
  const source = createHomeConfigSource(paths, {
    io: io(),
    watch: (onChange) => {
      onChange();
      return () => void events.push('unsubscribed');
    }
  });

  const unsubscribe = source.watch?.(() => events.push('changed')) ?? (() => {});
  unsubscribe();

  expect(events).toEqual(['changed', 'unsubscribed']);
});
