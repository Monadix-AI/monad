import type { MonadPaths } from '@monad/environment';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { computeInitStatus, initMonadHome, loadAll, loadAuth, pathsForHome } from '@monad/environment';

import { defaultSeedPath, ensureDevProvider } from '#/store/home/dev-init.ts';

function makePaths(base: string): MonadPaths {
  return pathsForHome(base);
}

let testDir: string;
let paths: MonadPaths;
// Absent seed path so the suite never reads the repo-root config.init.json; tests that need a seed
// file write to this path explicitly.
let seedPath: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `monad-devinit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  paths = makePaths(testDir);
  seedPath = join(testDir, 'config.init.json');
  await initMonadHome(paths);
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('ensureDevProvider', () => {
  test('default seed path points at repo packages/environment/config.init.json', () => {
    expect(defaultSeedPath()).toBe(resolve(import.meta.dir, '../../../../..', 'packages/environment/config.init.json'));
  });

  test('no-op when no API key is provided', async () => {
    const result = await ensureDevProvider(paths, { apiKey: '', seedPath });
    expect(result).toEqual({ seeded: false, reason: 'no-key' });

    const cfg = await loadAll(paths);
    if (!cfg) throw new Error('config missing');
    expect(computeInitStatus(cfg, await loadAuth(paths.auth)).initialized).toBe(false);
  });

  test('no-op when an API key but no model is provided', async () => {
    const result = await ensureDevProvider(paths, { apiKey: 'sk-or-test', model: '', seedPath });
    expect(result).toEqual({ seeded: false, reason: 'no-model' });
  });

  test('seeds an OpenRouter provider + default profile + credential from opts', async () => {
    const result = await ensureDevProvider(paths, {
      apiKey: 'sk-or-test',
      model: 'anthropic/claude-sonnet-4-6',
      seedPath
    });
    expect(result).toEqual({ seeded: true, model: 'anthropic/claude-sonnet-4-6' });

    const cfg = await loadAll(paths);
    const auth = await loadAuth(paths.auth);
    if (!cfg) throw new Error('config missing');
    expect(cfg.model.providers.some((p) => p.id === 'openrouter' && p.type === 'openrouter')).toBe(true);
    expect(cfg.model.default).toBe('default');
    expect(cfg.model.profiles.find((p) => p.alias === 'default')?.routes.chat.modelId).toBe(
      'anthropic/claude-sonnet-4-6'
    );
    expect(cfg.agent.agents.find((agent) => agent.id === cfg.agent.defaultAgentId)?.modelAlias).toBe('default');
    expect(cfg.model.providers.find((provider) => provider.id === 'openrouter')?.credentials[0]?.accessToken).toBe(
      'sk-or-test'
    );
    expect(auth?.credentials).toEqual({});
    expect(computeInitStatus(cfg, auth).initialized).toBe(true);
  });

  test('seeds from config.init.json, including a custom provider id + telegram channel', async () => {
    await writeFile(
      seedPath,
      JSON.stringify({
        provider: { id: 'custom', label: 'Custom', type: 'openrouter' },
        apiKey: 'sk-file',
        model: 'some/model',
        profileAlias: 'dev',
        telegram: { channelId: 'chn_DEVTG0000000', botToken: 'tok-123' }
      })
    );

    const result = await ensureDevProvider(paths, { seedPath });
    expect(result).toEqual({ seeded: true, model: 'some/model' });

    const cfg = await loadAll(paths);
    const auth = await loadAuth(paths.auth);
    if (!cfg) throw new Error('config missing');
    expect(cfg.model.default).toBe('dev');
    expect(cfg.model.profiles.find((p) => p.alias === 'dev')?.routes.chat.modelId).toBe('some/model');
    expect(cfg.agent.agents.find((agent) => agent.id === cfg.agent.defaultAgentId)?.modelAlias).toBe('dev');
    expect(cfg.model.providers.some((p) => p.id === 'custom')).toBe(true);
    expect(cfg.model.providers.find((provider) => provider.id === 'custom')?.credentials[0]?.accessToken).toBe(
      'sk-file'
    );
    expect(cfg.channels.find((channel) => channel.id === 'chn_DEVTG0000000')).toMatchObject({
      type: 'telegram',
      credential: { token: 'tok-123' }
    });
    expect(auth?.credentials).toEqual({});
  });

  test('opts override the seed file', async () => {
    await writeFile(seedPath, JSON.stringify({ apiKey: 'sk-file', model: 'file/model' }));

    const result = await ensureDevProvider(paths, { apiKey: 'sk-opts', model: 'opts/model', seedPath });
    expect(result).toEqual({ seeded: true, model: 'opts/model' });

    const cfg = await loadAll(paths);
    expect(cfg?.model.providers.find((provider) => provider.id === 'openrouter')?.credentials[0]?.accessToken).toBe(
      'sk-opts'
    );
  });

  test('no-op when already initialized (never clobbers existing config)', async () => {
    await ensureDevProvider(paths, { apiKey: 'sk-or-first', model: 'm/1', seedPath });
    const result = await ensureDevProvider(paths, { apiKey: 'sk-or-second', model: 'm/2', seedPath });
    expect(result).toEqual({ seeded: false, reason: 'already-initialized' });

    const cfg = await loadAll(paths);
    // Still the first key — second call did not add or replace anything.
    const credentials = cfg?.model.providers.find((provider) => provider.id === 'openrouter')?.credentials;
    expect(credentials).toHaveLength(1);
    expect(credentials?.[0]?.accessToken).toBe('sk-or-first');
  });
});
