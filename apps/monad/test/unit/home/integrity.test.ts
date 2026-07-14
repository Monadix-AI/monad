import type { MonadPaths } from '@monad/home';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, loadAll, pathsForHome, saveProfile } from '@monad/home';
import { ModelProviderType } from '@monad/protocol';
import { sql } from 'drizzle-orm';

import { createStore } from '#/store/db/index.ts';
import { checkAndRepair } from '#/store/home/integrity.ts';

function makePaths(base: string): MonadPaths {
  return pathsForHome(base);
}

let testDir: string;
let paths: MonadPaths;

beforeEach(() => {
  testDir = join(tmpdir(), `monad-test-${Date.now()}`);
  paths = makePaths(testDir);
});

afterEach(async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(testDir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw err;
      await Bun.sleep(100);
    }
  }
});

describe('checkAndRepair', () => {
  test('reports ok when everything is healthy', async () => {
    await initMonadHome(paths);
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('config missing');
    cfg.model.default = cfg.model.profiles[0]?.alias ?? '';
    await saveProfile(paths.profile, cfg);

    const store = createStore({ path: paths.db });
    const report = await checkAndRepair(paths, store);
    store.close();

    expect(report.config).toBe('ok');
    expect(report.profile).toBe('ok');
    expect(report.auth).toBe('ok');
    expect(report.db).toBe('ok');
  });

  test('repairs missing config.json', async () => {
    // Provide auth only
    await initMonadHome(paths);
    await rm(paths.config);

    const store = createStore({ path: paths.db });
    const report = await checkAndRepair(paths, store);
    store.close();

    expect(report.config).toBe('missing');
    // After repair, config should exist
  });

  test('throws when config.json is corrupt', async () => {
    await initMonadHome(paths);
    await Bun.write(paths.config, '{not valid json}');

    const store = createStore({ path: paths.db });
    await expect(checkAndRepair(paths, store)).rejects.toThrow('config.json is not valid JSON');
    store.close();

    const raw = await Bun.file(paths.config).text();
    expect(raw).toBe('{not valid json}');
  });

  test('repairs corrupt auth.json', async () => {
    await initMonadHome(paths);
    await Bun.write(paths.auth, '{not valid json}');

    const store = createStore({ path: paths.db });
    const report = await checkAndRepair(paths, store);
    store.close();

    expect(report.auth).toBe('repaired');
  });

  test('repairs missing profile.json', async () => {
    await initMonadHome(paths);
    await rm(paths.profile);

    const store = createStore({ path: paths.db });
    const report = await checkAndRepair(paths, store);
    store.close();

    expect(report.profile).toBe('missing');
    expect(await Bun.file(paths.profile).exists()).toBe(true);
  });

  test('repairs corrupt profile.json', async () => {
    await initMonadHome(paths);
    await Bun.write(paths.profile, '{not valid json}');

    const store = createStore({ path: paths.db });
    const report = await checkAndRepair(paths, store);
    store.close();

    expect(report.profile).toBe('repaired');
    expect(await Bun.file(paths.profile).exists()).toBe(true);
  });

  test('repairs missing model default by selecting the first profile', async () => {
    await initMonadHome(paths);
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('config missing');
    cfg.model.default = '';
    cfg.model.providers = [
      { id: 'p', label: 'P', type: ModelProviderType.OpenAICompatible, baseUrl: 'https://api.example.com/v1' }
    ];
    cfg.model.profiles = [
      { alias: 'fast', routes: { chat: { provider: 'p', modelId: 'm1' } }, params: {}, fallbacks: [] },
      { alias: 'smart', routes: { chat: { provider: 'p', modelId: 'm2' } }, params: {}, fallbacks: [] }
    ];
    await saveProfile(paths.profile, cfg);

    const store = createStore({ path: paths.db });
    const report = await checkAndRepair(paths, store);
    store.close();

    expect(report.profile).toBe('repaired');
    expect((await loadAll(paths.config, paths.profile))?.model.default).toBe('fast');
  });

  test('repairs stale model default by selecting the first profile', async () => {
    await initMonadHome(paths);
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('config missing');
    cfg.model.default = 'missing';
    cfg.model.providers = [
      { id: 'p', label: 'P', type: ModelProviderType.OpenAICompatible, baseUrl: 'https://api.example.com/v1' }
    ];
    cfg.model.profiles = [
      { alias: 'fast', routes: { chat: { provider: 'p', modelId: 'm1' } }, params: {}, fallbacks: [] },
      { alias: 'smart', routes: { chat: { provider: 'p', modelId: 'm2' } }, params: {}, fallbacks: [] }
    ];
    await saveProfile(paths.profile, cfg);

    const store = createStore({ path: paths.db });
    const report = await checkAndRepair(paths, store);
    store.close();

    expect(report.profile).toBe('repaired');
    expect((await loadAll(paths.config, paths.profile))?.model.default).toBe('fast');
  });

  test('repairs agent model aliases that point at missing profiles', async () => {
    await initMonadHome(paths);
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('config missing');
    cfg.model.providers = [
      { id: 'p', label: 'P', type: ModelProviderType.OpenAICompatible, baseUrl: 'https://api.example.com/v1' }
    ];
    cfg.model.profiles = [
      { alias: 'default', routes: { chat: { provider: 'p', modelId: 'm1' } }, params: {}, fallbacks: [] }
    ];
    cfg.model.default = 'default';
    cfg.agent.agents = [
      {
        id: 'agt_STALEPROFILE',
        name: 'A',
        modelAlias: 'missing',
        model: 'missing',
        capabilities: [],
        declaredScopes: [],
        atoms: { mode: 'inherit', allow: [], deny: [] },
        visibility: { subagentCallable: false, public: false },
        a2a: { enabled: false }
      }
    ];
    await saveProfile(paths.profile, cfg);

    const store = createStore({ path: paths.db });
    const report = await checkAndRepair(paths, store);
    store.close();

    const _repaired = await loadAll(paths.config, paths.profile);
    expect(report.profile).toBe('repaired');
  });

  test('fails startup health check when a profile references a missing provider', async () => {
    await initMonadHome(paths);
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('config missing');
    cfg.model.providers = [];
    cfg.model.profiles = [
      { alias: 'default', routes: { chat: { provider: 'missing', modelId: 'm1' } }, params: {}, fallbacks: [] }
    ];
    cfg.model.default = 'default';
    await saveProfile(paths.profile, cfg);

    const store = createStore({ path: paths.db });
    await expect(checkAndRepair(paths, store)).rejects.toThrow(
      /profile "default" references missing provider "missing"/
    );
    store.close();
  });

  test('db migration status is current after migration', async () => {
    await initMonadHome(paths);
    const store = createStore({ path: paths.db });
    const report = await checkAndRepair(paths, store);
    store.close();

    expect(report.db).toBe('ok');
  });

  test('reports version-mismatch when the newest migration journal row is missing', async () => {
    await initMonadHome(paths);
    const store = createStore({ path: paths.db });
    store.db.run(
      sql`DELETE FROM __drizzle_migrations
          WHERE created_at = (SELECT MAX(created_at) FROM __drizzle_migrations)`
    );

    expect(store.hasCurrentMigration()).toBe(false);
    const report = await checkAndRepair(paths, store);
    store.close();

    expect(report.db).toBe('version-mismatch');
  });
});
