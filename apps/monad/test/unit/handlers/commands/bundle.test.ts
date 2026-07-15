import type { Event, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { createDefaultConfig } from '@monad/home';

import { createCommandBundle } from '#/handlers/commands/bundle.ts';
import { createStore } from '#/store/db/index.ts';

test('command bundle model commands read and write a project-bound session', async () => {
  const store = createStore();
  const published: Event[] = [];
  const cfg = createDefaultConfig('prn_100000000000', 'tester');
  cfg.model.profiles = [
    { alias: 'fast', routes: { chat: { provider: 'test', modelId: 'fast-model' } }, params: {}, fallbacks: [] },
    { alias: 'smart', routes: { chat: { provider: 'test', modelId: 'smart-model' } }, params: {}, fallbacks: [] }
  ];
  cfg.model.default = 'fast';
  store.insertWorkplaceProject({
    id: 'prj_project00000',
    title: 'project',
    ownerPrincipalId: 'prn_100000000000',
    state: 'active',
    archived: false,
    memberTemplates: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  });
  const sessionId = 'ses_projects1xer' as SessionId;
  store.insertSession({
    id: sessionId,
    projectId: 'prj_project00000',
    title: 'project session',
    ownerPrincipalId: 'prn_100000000000',
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
    modelService: { profiles: cfg.model.profiles, providers: [{ id: 'test' }] } as never,
    modelCatalog: {
      pickProfileForTier: () => undefined,
      lookupCapabilities: () => ({ reasoningEfforts: ['low', 'high'] })
    } as never,
    agentModel: {} as never,
    history: {} as never,
    runConsolidate: async () => ({ scopes: [] }) as never,
    explainBelief: async () => ({}) as never,
    runCheckContradictions: async () => ({}) as never,
    oversight: {} as never,
    i18n: {} as never,
    bus: { publish: (event: Event) => published.push(event) } as never,
    sessionGateway: () => null,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never
  });

  expect((await bundle.listModels(sessionId)).find((profile) => profile.alias === 'fast')?.current).toBe(true);
  await bundle.setModel(sessionId, 'smart');
  expect(store.getSession(sessionId)?.model).toBe('smart');
  expect((await bundle.listModels(sessionId)).find((profile) => profile.alias === 'smart')?.current).toBe(true);
  await bundle.setModel(sessionId, 'test:catalog-model');
  expect(store.getSession(sessionId)?.model).toBe('test:catalog-model');
  await (bundle as typeof bundle & { setEffort(id: SessionId, effort?: string): Promise<void> }).setEffort(
    sessionId,
    'high'
  );
  expect(store.getSession(sessionId)?.reasoningEffort).toBe('high');
  await bundle.setModel(sessionId, 'smart');
  expect(store.getSession(sessionId)?.reasoningEffort).toBeUndefined();
  expect(published.filter((event) => event.type === 'session.updated')).toHaveLength(4);
  await (bundle as typeof bundle & { setEffort(id: SessionId, effort?: string): Promise<void> }).setEffort(
    sessionId,
    'low'
  );
  await bundle.setModel(sessionId, 'inherit');
  expect(store.getSession(sessionId)?.model).toBeUndefined();
  expect(store.getSession(sessionId)?.reasoningEffort).toBeUndefined();
  await expect(bundle.setModel(sessionId, 'missing:catalog-model')).rejects.toThrow(
    'Unknown model profile: missing:catalog-model'
  );
  store.close();
});
