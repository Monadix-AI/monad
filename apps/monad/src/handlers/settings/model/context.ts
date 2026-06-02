import type { MonadAuth, MonadConfig, MonadPaths } from '@monad/environment';
import type { ModelModalities, ModelPrice } from '@monad/protocol';
import type { ModelProviderRegistry } from '#/agent/index.ts';
import type { ConfigAccess } from '#/config/manager.ts';
import type { ModelService } from '#/services/model.ts';
import type { ModelCatalogService } from '#/services/model-catalog.ts';

import { join } from 'node:path';
import { emptyAuth } from '@monad/environment';

export interface ModelDeps {
  paths: MonadPaths;
  modelService: ModelService;
  // Optional: the daemon always injects it (main.ts); absent (e.g. in tests) just means model
  // listings carry no catalog price — pricing display degrades to nothing, never errors.
  modelCatalog?: ModelCatalogService;
}

export type ModelSettingsDeps = ModelDeps & { config: ConfigAccess };

export interface ModelContext {
  read(): Promise<{ cfg: MonadConfig; auth: MonadAuth }>;
  commit(cfg: MonadConfig, auth?: MonadAuth): Promise<void>;
  commitAuth(cfg: MonadConfig, auth: MonadAuth): Promise<void>;
  readonly providerModelCachePath: string;
  /** Live provider registry — lets model-listing honor atom packs with listModels(). */
  readonly registry: ModelProviderRegistry;
  /** Strict catalog price join for display — exact id match only (see ModelCatalogService). */
  lookupPriceExact(provider: string, modelId: string): ModelPrice | undefined;
  /** Catalog context-window limit for display and runtime hints. */
  lookupContextLimit(provider: string, modelId: string): number | undefined;
  /** Catalog release date for display ordering. */
  lookupReleaseDate(provider: string, modelId: string): string | undefined;
  /** Exact models.dev page link when this model is present in the catalog. */
  lookupModelsDevUrl(provider: string, modelId: string): string | undefined;
  /** Display name from an exact models.dev id match. */
  lookupLabel(provider: string, modelId: string): string | undefined;
  /** Catalog modalities join (input/output/flags/kind) for role-candidate filtering. */
  lookupCapabilities(provider: string, modelId: string): ModelModalities | undefined;
}

export function createModelContext({ paths, modelService, modelCatalog, config }: ModelSettingsDeps): ModelContext {
  async function read(): Promise<{ cfg: MonadConfig; auth: MonadAuth }> {
    const { cfg, auth: storedAuth } = structuredClone(config.get());
    const auth = storedAuth ?? emptyAuth();
    return { cfg, auth };
  }

  async function commit(cfg: MonadConfig, auth?: MonadAuth): Promise<void> {
    await config.update((draft) => {
      draft.cfg = cfg;
      if (auth) draft.auth = auth;
    });
  }

  async function commitAuth(cfg: MonadConfig, auth: MonadAuth): Promise<void> {
    auth.updatedAt = new Date().toISOString();
    await config.update((draft) => {
      draft.cfg = cfg;
      draft.auth = auth;
    });
  }

  return {
    read,
    commit,
    commitAuth,
    providerModelCachePath: join(paths.cache, 'provider-models.json'),
    registry: modelService.registry,
    lookupPriceExact: (provider, modelId) => modelCatalog?.lookupPriceExact(provider, modelId),
    lookupContextLimit: (provider, modelId) => modelCatalog?.lookupContextLimit(provider, modelId),
    lookupReleaseDate: (provider, modelId) => modelCatalog?.lookupReleaseDate(provider, modelId),
    lookupModelsDevUrl: (provider, modelId) => modelCatalog?.lookupModelsDevUrl(provider, modelId),
    lookupLabel: (provider, modelId) => modelCatalog?.lookupLabel(provider, modelId),
    lookupCapabilities: (provider, modelId) => modelCatalog?.lookupCapabilities(provider, modelId)
  };
}
