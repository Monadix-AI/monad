import type { SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { createDefaultConfig } from '@monad/home';

import { createCommandBundle } from '@/bootstrap/commands.ts';
import { createStore } from '@/store/db/index.ts';

test('command bundle model commands read and write a project-bound session', async () => {
  const store = createStore();
  const cfg = createDefaultConfig('prn_1', 'tester');
  cfg.model.profiles = [
    { alias: 'fast', routes: { chat: { provider: 'test', modelId: 'fast-model' } }, params: {}, fallbacks: [] },
    { alias: 'smart', routes: { chat: { provider: 'test', modelId: 'smart-model' } }, params: {}, fallbacks: [] }
  ];
  cfg.model.default = 'fast';
  store.insertWorkplaceProject({
    id: 'prj_project',
    title: 'project',
    ownerPrincipalId: 'prn_1',
    state: 'active',
    archived: false,
    memberTemplates: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  });
  const sessionId = 'ses_project_session' as SessionId;
  store.insertSession({
    id: sessionId,
    projectId: 'prj_project',
    title: 'project session',
    ownerPrincipalId: 'prn_1',
    state: 'active',
    agentIds: [],
    parentSessionId: null,
    archived: false,
    restoreCount: 0,
    origin: {
      surface: 'web',
      client: 'workplace',
      transport: 'http',
      writableBy: ['http'],
      branchableBy: ['http']
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  });

  const bundle = createCommandBundle({
    commandRegistry: {} as never,
    skills: () => [],
    store,
    cfg,
    modelService: { profiles: cfg.model.profiles } as never,
    modelCatalog: { pickProfileForTier: () => undefined } as never,
    agentModel: {} as never,
    history: {} as never,
    runConsolidate: async () => ({ scopes: [] }) as never,
    explainBelief: async () => ({}) as never,
    runCheckContradictions: async () => ({}) as never,
    oversight: {} as never,
    i18n: {} as never,
    bus: {} as never,
    sessionGateway: () => null,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never
  });

  expect((await bundle.listModels(sessionId)).find((profile) => profile.alias === 'fast')?.current).toBe(true);
  await bundle.setModel(sessionId, 'smart');
  expect(store.getSession(sessionId)?.model).toBe('smart');
  expect((await bundle.listModels(sessionId)).find((profile) => profile.alias === 'smart')?.current).toBe(true);
  store.close();
});
