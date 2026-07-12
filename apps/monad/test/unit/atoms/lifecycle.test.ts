import type { MonadPaths } from '@monad/home';
import type { PrincipalId } from '@monad/protocol';
import type { ModelSubsystem } from '#/agent/model/lifecycle.ts';
import type { AtomDiscovery } from '#/atoms/lifecycle.ts';
import type { ConfigSnapshot } from '#/config/service.ts';
import type { EmbeddingIndexer } from '#/services/embedding-indexer.ts';
import type { ModelService } from '#/services/model.ts';
import type { ModelCatalogService } from '#/services/model-catalog.ts';

import { expect, test } from 'bun:test';
import { createDefaultConfig } from '@monad/home';

import { createAtomsLifecycleModule } from '#/atoms/lifecycle.ts';
import { createCapabilitiesRuntime } from '#/capabilities/lifecycle.ts';
import { RuntimeContext } from '#/runtime/context.ts';

test('discovers atoms from stable capabilities and model dependencies', async () => {
  const cfg = createDefaultConfig('usr_test' as PrincipalId, 'Test');
  const initial: ConfigSnapshot = { cfg, auth: null };
  const paths = { credentials: '/home/credentials' } as MonadPaths;
  const capabilities = createCapabilitiesRuntime({ paths, sandboxRoots: ['/workspace'], tools: [] });
  const modelService = {} as ModelService;
  const model = {
    modelService,
    modelCatalog: {} as ModelCatalogService,
    embeddingIndexer: {} as EmbeddingIndexer,
    stop: () => {}
  } satisfies ModelSubsystem;
  const discovery = {
    channelRegistry: new Map(),
    atomConflicts: [],
    atomDetailsByPack: new Map(),
    refreshWorkspaceExperienceSnapshot: async () => {},
    getWorkspaceExperienceSnapshot: () => undefined
  } satisfies AtomDiscovery;
  const calls: unknown[][] = [];
  const context = new RuntimeContext();
  context.commit('capabilities', capabilities);
  context.commit('agent.model', model);
  const module = createAtomsLifecycleModule({ initial, paths, logger: { warn: () => {} } }, async (options) => {
    calls.push([options.cfg, options.registry, options.commandRegistry, options.modelService]);
    return discovery;
  });

  const output = await module.start(context, new AbortController().signal);

  expect({ calls, criticality: module.criticality, id: module.id, output, requires: module.requires }).toEqual({
    calls: [[cfg, capabilities.registry, capabilities.commandRegistry, modelService]],
    criticality: 'required',
    id: 'atoms',
    output: discovery,
    requires: ['capabilities', 'agent.model']
  });
});
