import type { MonadAuth, MonadConfig, MonadPaths } from '@monad/environment';
import type { ConfigSnapshot } from '#/config/manager.ts';
import type { RuntimeModule } from '#/runtime/types.ts';
import type { Store } from '#/store/db/index.ts';
import type { DataLayer } from '#/store/lifecycle.ts';

import { join } from 'node:path';
import { logger } from '@monad/logger';

import { EmbeddingIndexer } from '#/services/embedding-indexer.ts';
import { createEmptyProviderRegistry, ModelService } from '#/services/model.ts';
import { ModelCatalogService } from '#/services/model-catalog.ts';

interface ModelSubsystemOptions {
  cfg: MonadConfig;
  paths: MonadPaths;
  store: Store;
  useMock: boolean;
  auth: MonadAuth | null;
}

export interface ModelSubsystem {
  modelService: ModelService;
  modelCatalog: ModelCatalogService;
  embeddingIndexer: EmbeddingIndexer;
  stop(): void;
}

export interface ModelSubsystemCleanup {
  clearIndexerInterval(): void;
  stopCatalog(): void;
}

export type StartModelSubsystem = (options: ModelSubsystemOptions) => Promise<ModelSubsystem>;

export function createEmbeddingModelChangeWarning(previous: string, next: string, stale: number): string {
  return (
    `monad: embedding model changed (${previous} → ${next}); ${stale} existing embedding(s) are stale. ` +
    'Re-index from model settings (or POST /v1/settings/model/embeddings/reindex).'
  );
}

export interface ModelLifecycleOptions {
  initial: ConfigSnapshot;
  paths: MonadPaths;
  useMock: boolean;
}

export function createModelSubsystemStop(resources: ModelSubsystemCleanup): () => void {
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    let failure: unknown;
    for (const stop of [resources.clearIndexerInterval, resources.stopCatalog]) {
      try {
        stop();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  };
}

async function createModelSubsystem(options: ModelSubsystemOptions): Promise<ModelSubsystem> {
  const { cfg, paths, store, useMock, auth } = options;
  const modelService = new ModelService(paths.auth, cfg, auth, createEmptyProviderRegistry());
  const modelCatalog = new ModelCatalogService({
    cachePath: join(paths.cache, 'model-catalog.json'),
    log: (level, message) => logger[level](message)
  });
  await modelCatalog.loadCache();
  modelService.setCatalog(modelCatalog);
  if (!useMock) {
    void modelCatalog.refresh();
    modelCatalog.startAutoRefresh();
  }

  const embeddingIndexer = new EmbeddingIndexer({
    store,
    embed: (texts) => {
      const embed = modelService.router.embed;
      if (!embed) throw new Error('model router does not support embeddings');
      return embed.call(modelService.router, texts);
    },
    embeddingModelSpec: () => modelService.embeddingModel,
    price: (provider, modelId) => modelCatalog.lookupPrice(provider, modelId),
    log: (level, message) => logger[level](message)
  });
  embeddingIndexer.kick();
  const indexerInterval = setInterval(() => embeddingIndexer.kick(), 120_000);
  indexerInterval.unref();

  const stopResources = createModelSubsystemStop({
    clearIndexerInterval: () => clearInterval(indexerInterval),
    stopCatalog: () => modelCatalog.stop()
  });
  const onExit = () => stopResources();
  process.once('exit', onExit);

  return {
    modelService,
    modelCatalog,
    embeddingIndexer,
    stop: () => {
      process.off('exit', onExit);
      stopResources();
    }
  };
}

export function createModelLifecycleModule(
  options: ModelLifecycleOptions,
  start: StartModelSubsystem = createModelSubsystem
): RuntimeModule<ConfigSnapshot> {
  return {
    id: 'agent.model',
    criticality: 'required',
    requires: ['store'],
    start: async (context) => {
      const layer = context.get<DataLayer>('store');
      const subsystem = await start({
        cfg: options.initial.cfg,
        paths: options.paths,
        store: layer.store,
        useMock: options.useMock,
        auth: options.initial.auth
      });
      try {
        const discovered = await subsystem.modelService.discoverProviders(options.paths.providers);
        for (const error of discovered.errors) {
          logger.warn(`monad: provider atom "${error.file}" failed to load: ${error.error}`);
        }
        return subsystem;
      } catch (error) {
        try {
          subsystem.stop();
        } catch (stopError) {
          logger.warn(`monad: model startup cleanup failed: ${stopError}`);
        }
        throw error;
      }
    },
    reload: (current, snapshot, context) => {
      const subsystem = current as ModelSubsystem;
      const previousEmbedding = subsystem.modelService.embeddingModel;
      subsystem.modelService.reload(snapshot.cfg, snapshot.auth);
      const nextEmbedding = subsystem.modelService.embeddingModel;
      if (previousEmbedding && nextEmbedding && previousEmbedding !== nextEmbedding) {
        const layer = context.get<DataLayer>('store');
        const modelId = nextEmbedding.split(':').slice(1).join(':') || nextEmbedding;
        const stale = layer.store.staleEmbeddingCount(modelId);
        if (stale > 0) logger.warn(createEmbeddingModelChangeWarning(previousEmbedding, nextEmbedding, stale));
      }
      return Promise.resolve(subsystem);
    },
    stop: (current) => (current as ModelSubsystem).stop()
  };
}
