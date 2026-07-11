import type { MonadConfig, MonadPaths } from '@monad/home';
import type { PrincipalId } from '@monad/protocol';
import type { HomeConfigIo } from '#/config/source.ts';

import { expect, test } from 'bun:test';
import { createDefaultConfig, emptyAuth } from '@monad/home';

import { createHomeConfigSource } from '#/config/source.ts';

const paths = {
  auth: '/home/auth.json',
  config: '/home/config.json',
  profile: '/home/profile.json'
} satisfies Pick<MonadPaths, 'auth' | 'config' | 'profile'>;

function config(): MonadConfig {
  return createDefaultConfig('usr_test' as PrincipalId, 'Test');
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
      loadConfig: async (configPath, profilePath) => {
        reads.push(`config:${configPath}:${profilePath}`);
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
  expect(reads.sort()).toEqual([`auth:${paths.auth}`, `config:${paths.config}:${paths.profile}`]);
});

test('returns null when the config input is unavailable', async () => {
  const source = createHomeConfigSource(paths, { io: io({ loadConfig: async () => null }) });

  expect(await source.load()).toBeNull();
});

test('delegates profile and auth writes to canonical paths', async () => {
  const cfg = config();
  const auth = emptyAuth();
  const writes: string[] = [];
  const source = createHomeConfigSource(paths, {
    io: io({
      saveConfig: async (path, value) => void writes.push(`config:${path}:${value.principal.id}`),
      saveAuth: async (path, value) => void writes.push(`auth:${path}:${value.version}`)
    })
  });

  await source.saveConfig(cfg);
  await source.saveAuth(auth);

  expect(writes).toEqual([`config:${paths.profile}:${cfg.principal.id}`, `auth:${paths.auth}:${auth.version}`]);
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
