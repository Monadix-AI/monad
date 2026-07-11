import type { MonadConfig, MonadPaths } from '@monad/home';
import type { PrincipalId } from '@monad/protocol';
import type { ModelSubsystem } from '#/agent/model/lifecycle.ts';
import type { ConfigSnapshot } from '#/config/service.ts';
import type { EmbeddingIndexer } from '#/services/embedding-indexer.ts';
import type { KvService } from '#/services/kv.ts';
import type { ModelService } from '#/services/model.ts';
import type { ModelCatalogService } from '#/services/model-catalog.ts';
import type { Store } from '#/store/db/index.ts';
import type { DataLayer } from '#/store/lifecycle.ts';

import { expect, test } from 'bun:test';
import { createDefaultConfig } from '@monad/home';

import { createModelLifecycleModule, createModelSubsystemStop } from '#/agent/model/lifecycle.ts';
import { RuntimeContext } from '#/runtime/context.ts';

const paths = { providers: '/home/providers' } as MonadPaths;
const layer = { kv: {} as KvService, store: {} as Store, stop: async () => {} } satisfies DataLayer;

function snapshot(model: string): ConfigSnapshot {
  const cfg = createDefaultConfig('usr_test' as PrincipalId, 'Test');
  return { auth: null, cfg: { ...cfg, model: { ...cfg.model, default: model } } };
}

function fakeSubsystem(events: string[]): ModelSubsystem {
  return {
    modelService: {
      discoverProviders: async () => {
        events.push('providers:discover');
        return { errors: [], loaded: [] };
      },
      reload: (cfg: MonadConfig) => void events.push(`model:reload:${cfg.model.default}`)
    } as unknown as ModelService,
    modelCatalog: {} as ModelCatalogService,
    embeddingIndexer: {} as EmbeddingIndexer,
    stop: () => void events.push('subsystem:stop')
  };
}

test('requires store and discovers providers before model readiness', async () => {
  const events: string[] = [];
  const subsystem = fakeSubsystem(events);
  const context = new RuntimeContext();
  context.commit('store', layer);
  const module = createModelLifecycleModule({ initial: snapshot('a'), paths, useMock: false }, async ({ store }) => {
    events.push(`factory:${store === layer.store}`);
    return subsystem;
  });

  const output = await module.start(context, new AbortController().signal);

  expect({ events, id: module.id, requires: module.requires, output }).toEqual({
    events: ['factory:true', 'providers:discover'],
    id: 'agent.model',
    requires: ['store'],
    output: subsystem
  });
});

test('reloads the stable model service from the complete config snapshot', async () => {
  const events: string[] = [];
  const subsystem = fakeSubsystem(events);
  const module = createModelLifecycleModule({ initial: snapshot('a'), paths, useMock: false }, async () => subsystem);

  const output = await module.reload?.(subsystem, snapshot('b'), new RuntimeContext(), new AbortController().signal);

  expect({ events, output }).toEqual({ events: ['model:reload:b'], output: subsystem });
});

test('stops the owned model subsystem through lifecycle shutdown', async () => {
  const events: string[] = [];
  const subsystem = fakeSubsystem(events);
  const module = createModelLifecycleModule({ initial: snapshot('a'), paths, useMock: false }, async () => subsystem);

  await module.stop?.(subsystem, new RuntimeContext());

  expect(events).toEqual(['subsystem:stop']);
});

test('cleans up the model subsystem when provider discovery aborts startup', async () => {
  const events: string[] = [];
  const subsystem = fakeSubsystem(events);
  subsystem.modelService.discoverProviders = async () => {
    events.push('providers:discover');
    throw new Error('provider directory unavailable');
  };
  const context = new RuntimeContext();
  context.commit('store', layer);
  const module = createModelLifecycleModule({ initial: snapshot('a'), paths, useMock: false }, async () => subsystem);

  await expect(module.start(context, new AbortController().signal)).rejects.toThrow('provider directory unavailable');

  expect(events).toEqual(['providers:discover', 'subsystem:stop']);
});

test('model subsystem cleanup is idempotent', () => {
  const events: string[] = [];
  const stop = createModelSubsystemStop({
    clearIndexerInterval: () => void events.push('interval'),
    stopCatalog: () => void events.push('catalog')
  });

  stop();
  stop();

  expect(events).toEqual(['interval', 'catalog']);
});
