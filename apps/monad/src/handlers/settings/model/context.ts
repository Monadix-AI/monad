import type { MonadAuth, MonadConfig, MonadPaths } from '@monad/home';
import type { ModelModalities, ModelPrice } from '@monad/protocol';
import type { ModelProviderRegistry } from '@/agent/index.ts';
import type { ConfigBus } from '@/services/config-bus.ts';
import type { ModelService } from '@/services/model.ts';
import type { ModelCatalogService } from '@/services/model-catalog.ts';

import { loadAll, loadAuth, saveAuth, saveProfile } from '@monad/home';

export interface ModelDeps {
  paths: MonadPaths;
  modelService: ModelService;
  // Optional: the daemon always injects it (main.ts); absent (e.g. in tests) just means model
  // listings carry no catalog price — pricing display degrades to nothing, never errors.
  modelCatalog?: ModelCatalogService;
  configBus?: ConfigBus;
}

export interface ModelContext {
  read(): Promise<{ cfg: MonadConfig; auth: MonadAuth }>;
  commit(cfg: MonadConfig, auth?: MonadAuth): Promise<void>;
  commitAuth(cfg: MonadConfig, auth: MonadAuth): Promise<void>;
  /** Live provider registry — lets model-listing honor atom packs with listModels(). */
  readonly registry: ModelProviderRegistry;
  /** Strict catalog price join for display — exact id match only (see ModelCatalogService). */
  lookupPriceExact(provider: string, modelId: string): ModelPrice | undefined;
  /** Catalog modalities join (input/output/flags/kind) for role-candidate filtering. */
  lookupCapabilities(provider: string, modelId: string): ModelModalities | undefined;
}

export function createModelContext({ paths, modelService, modelCatalog, configBus }: ModelDeps): ModelContext {
  async function read(): Promise<{ cfg: MonadConfig; auth: MonadAuth }> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('model: config.json missing');
    const auth = (await loadAuth(paths.auth)) ?? {
      version: 1 as const,
      activeProvider: null,
      updatedAt: new Date().toISOString(),
      credentialPool: {}
    };
    return { cfg, auth };
  }

  async function commit(cfg: MonadConfig, auth?: MonadAuth): Promise<void> {
    await saveProfile(paths.profile, cfg);
    if (auth) await saveAuth(paths.auth, auth);
    const resolvedAuth = auth ?? (await loadAuth(paths.auth));
    if (configBus) {
      await configBus.publish({ cfg, auth: resolvedAuth });
    } else {
      modelService.reload(cfg, resolvedAuth);
    }
  }

  async function commitAuth(cfg: MonadConfig, auth: MonadAuth): Promise<void> {
    auth.updatedAt = new Date().toISOString();
    await saveAuth(paths.auth, auth);
    if (configBus) {
      await configBus.publish({ cfg, auth });
    } else {
      modelService.reload(cfg, auth);
    }
  }

  return {
    read,
    commit,
    commitAuth,
    registry: modelService.registry,
    lookupPriceExact: (provider, modelId) => modelCatalog?.lookupPriceExact(provider, modelId),
    lookupCapabilities: (provider, modelId) => modelCatalog?.lookupCapabilities(provider, modelId)
  };
}
