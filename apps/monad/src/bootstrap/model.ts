// Boot phase: the model subsystem — the router/profile service, the model catalog (pricing +
// context limits, with a cached background refresh), and the off-request-path embedding indexer for
// semantic search. Returns the three handles the rest of startDaemon wires into agents, handlers,
// and hot-reload.

import type { MonadAuth, MonadConfig, MonadPaths } from '@monad/home';
import type { Store } from '@/store/db/index.ts';

import { join } from 'node:path';
import { logger } from '@monad/logger';

import { EmbeddingIndexer } from '@/services/embedding-indexer.ts';
import { createEmptyProviderRegistry, ModelService } from '@/services/model.ts';
import { ModelCatalogService } from '@/services/model-catalog.ts';

export interface ModelSubsystem {
  modelService: ModelService;
  modelCatalog: ModelCatalogService;
  embeddingIndexer: EmbeddingIndexer;
}

export async function createModelSubsystem(deps: {
  cfg: MonadConfig;
  paths: MonadPaths;
  store: Store;
  useMock: boolean;
  /** Auth loaded once at startup, reused here so bootstrap doesn't re-read auth.json. */
  auth: MonadAuth | null;
}): Promise<ModelSubsystem> {
  const { cfg, paths, store, useMock, auth } = deps;

  const modelService = new ModelService(paths.auth, cfg, auth, createEmptyProviderRegistry());

  const modelCatalog = new ModelCatalogService({
    cachePath: join(paths.cache, 'model-catalog.json'),
    log: (level, message) => logger[level](message)
  });
  await modelCatalog.loadCache();
  modelService.setCatalog(modelCatalog);
  if (!useMock) {
    void modelCatalog.refresh(); // detached — never blocks daemon boot on a network call
    modelCatalog.startAutoRefresh();
    process.on('exit', () => modelCatalog.stop());
  }

  // Background embedding indexer: embeds messages off the request path so semantic search never
  // blocks on a synchronous backfill. Work-list is DB-derived, so it resumes after a restart.
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
  embeddingIndexer.kick(); // startup backfill of anything indexed-missing (e.g. configured offline)
  // Safety-net drain: most message writes kick the indexer directly, but some paths don't (e.g.
  // slash-command directive rows, generative-message inserts). A low-frequency periodic kick
  // catches anything those paths miss without threading the indexer through every call site. The
  // kick is a cheap no-op when nothing is pending. `.unref()` so it never keeps the process alive.
  setInterval(() => embeddingIndexer.kick(), 120_000).unref();

  return { modelService, modelCatalog, embeddingIndexer };
}
