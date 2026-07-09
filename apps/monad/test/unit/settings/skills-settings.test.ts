import type { MonadPaths } from '@monad/home';

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultConfig, loadAll, saveAll, saveAuth } from '@monad/home';
import { ModelProviderType } from '@monad/protocol';

import { createSkillsSettingsModule } from '#/handlers/settings/skills/index.ts';

let dir: string;
let paths: MonadPaths;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'monad-skills-settings-'));
  paths = {
    home: dir,
    runtime: dir,
    configs: dir,
    config: join(dir, 'config.json'),
    profile: join(dir, 'profile.json'),
    approvals: join(dir, 'approvals.json'),
    credentials: join(dir, 'credentials'),
    auth: join(dir, 'credentials', 'auth.json'),
    tls: join(dir, 'credentials', 'tls'),
    workspace: dir,
    providers: dir,
    skills: join(dir, 'skills'),
    skillsLock: join(dir, 'skills.lock'),
    locales: '/dev/null',
    mcp: '/dev/null',
    atoms: join(dir, 'atoms'),
    packs: join(dir, 'atoms', 'packs'),
    agents: join(dir, 'agents'),
    memory: dir,
    backup: dir,
    cache: dir,
    logs: join(dir, 'logs'),
    bin: join(dir, 'bin'),
    dbDir: dir,
    db: join(dir, 'db.sqlite'),
    sock: join(dir, 'monad.sock'),
    kvSock: join(dir, 'kv.sock'),
    pid: join(dir, 'monad.pid')
  };
  await mkdir(paths.credentials, { recursive: true });
  await saveAll(paths.config, paths.profile, createDefaultConfig('prn_test00000000', 'Test'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('install review setting cannot be enabled without a usable model', async () => {
  const mod = createSkillsSettingsModule(paths);

  await expect(mod.setSkillsSettings({ installReview: true })).rejects.toThrow(/usable model/);
  expect(await mod.getSkillsSettings()).toMatchObject({ installReview: false, installReviewAvailable: false });
});

test('install review setting can use any configured model with credentials', async () => {
  const cfg = await loadAll(paths.config, paths.profile);
  if (!cfg) throw new Error('config missing');
  cfg.model.default = '';
  cfg.model.providers.push({
    id: 'review-provider',
    label: 'Review Provider',
    type: ModelProviderType.OpenAICompatible
  });
  cfg.model.profiles.push({
    alias: 'review',
    routes: { chat: { provider: 'review-provider', modelId: 'review-model' } },
    params: {},
    fallbacks: []
  });
  await saveAll(paths.config, paths.profile, cfg);
  await saveAuth(paths.auth, {
    version: 1,
    activeProvider: null,
    updatedAt: new Date().toISOString(),
    credentialPool: {
      'review-provider': [
        {
          id: 'cred_review',
          label: 'review',
          authType: 'api_key',
          priority: 0,
          source: 'user',
          accessToken: 'sk-review',
          lastStatus: 'unknown',
          lastStatusAt: null,
          lastErrorCode: null,
          lastErrorReason: null,
          lastErrorMessage: null,
          lastErrorResetAt: null,
          requestCount: 0
        }
      ]
    }
  });

  const mod = createSkillsSettingsModule(paths);
  expect(await mod.getSkillsSettings()).toMatchObject({ installReview: false, installReviewAvailable: true });

  const updated = await mod.setSkillsSettings({ installReview: true });

  expect(updated).toMatchObject({ installReview: true, installReviewAvailable: true });
  expect((await loadAll(paths.config, paths.profile))?.skills.installReview).toBe(true);
});
