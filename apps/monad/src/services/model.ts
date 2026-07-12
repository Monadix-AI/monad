import type { Credential, MonadAuth, MonadConfig } from '@monad/home';
import type { ModelRole } from '@monad/protocol';
import type { ProviderCredential } from '@monad/sdk-atom';
import type { DiscoverResult, GatewayDeps, ModelRouter } from '#/agent/index.ts';
import type { ModelCatalogService } from '#/services/model-catalog.ts';

import { saveAuth } from '@monad/home';

import { GatewayModelRouter, ModelProviderRegistry } from '#/agent/index.ts';
import { DEFAULT_PROFILE_ALIAS, resolveModelRole } from '#/config/resolve.ts';
import { getHttp2Fetch } from '#/infra/http2-fetch.ts';

/** An empty provider registry — the daemon fills it from `builtinAtomPack` (+ any third-party
 *  `provider` atom) so providers flow through the unified loader, not a separate seed. ModelService
 *  defaults to this; tests that need the first-party providers present without running the full
 *  loader seed their own registry (see the `seededProviderRegistry` test helper). */
export function createEmptyProviderRegistry(): ModelProviderRegistry {
  return new ModelProviderRegistry();
}

const EMPTY_AUTH: MonadAuth = { version: 1, activeProvider: null, updatedAt: '', credentialPool: {} };
const SAVE_DEBOUNCE_MS = 1000;

export class ModelService {
  readonly router: ModelRouter;
  readonly registry: ModelProviderRegistry;

  private cfg: MonadConfig;
  private auth: MonadAuth;
  private catalog?: ModelCatalogService;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly authPath: string,
    cfg: MonadConfig,
    auth: MonadAuth | null,
    registry: ModelProviderRegistry = createEmptyProviderRegistry()
  ) {
    this.cfg = cfg;
    this.auth = auth ?? structuredClone(EMPTY_AUTH);
    this.registry = registry;

    const self = this;
    const deps: GatewayDeps = {
      // Live reads so reload() takes effect without rebuilding the router.
      get providers() {
        return self.cfg.model.providers;
      },
      get profiles() {
        return self.cfg.model.profiles;
      },
      get defaultProfile() {
        return self.cfg.model.default || DEFAULT_PROFILE_ALIAS;
      },
      get searchToolProvider() {
        return self.cfg.agent.tools.webSearch.provider;
      },
      // resolveModelRole('embedding') === roles.embedding (no fallback).
      get embeddingModel() {
        return resolveModelRole(self.cfg.model, 'embedding');
      },
      credentialsFor: (providerId) =>
        (self.auth.credentialPool[providerId] ?? [])
          .slice()
          .sort((a, b) => a.priority - b.priority)
          .map(credentialToHandle),
      reportCredential: (providerId, credId, ok, err) => self.reportCredential(providerId, credId, ok, err),
      fetch: getHttp2Fetch()
    };

    this.router = new GatewayModelRouter(deps, registry);
  }

  /** Live (hot-reloaded) model profiles — the configured alias→provider/model set. Read by
   *  capability-tier resolution so a `context: fork` skill's tier maps to a current profile. */
  get profiles(): MonadConfig['model']['profiles'] {
    return this.cfg.model.profiles;
  }

  /** Live operator tier pins (profile alias → tier) — override the catalog's cost-ranking. */
  get tierOverrides(): MonadConfig['model']['tierOverrides'] {
    return this.cfg.model.tierOverrides;
  }

  /** Live embedding-model spec ("providerId:modelId") or undefined when no embedding role is set.
   *  The background indexer reads this to know whether (and with which model) to index. */
  get embeddingModel(): string | undefined {
    return resolveModelRole(this.cfg.model, 'embedding');
  }

  /** Wire in the model catalog so capability-based role fallback is enforced at runtime.
   *  Called once after the catalog is ready (agent/model/lifecycle.ts). */
  setCatalog(catalog: ModelCatalogService): void {
    this.catalog = catalog;
  }

  /** Live role→model resolution against the current config (applies the role fallback chain).
   *  Passed to the vision/image/speech tools as a thunk so role edits hot-reload without rebuild. */
  roleModel(role: ModelRole): string | undefined {
    const catalog = this.catalog;
    const lookupCapabilities = this.catalog
      ? (provider: string, modelId: string) => catalog?.lookupCapabilities(provider, modelId)
      : undefined;
    return resolveModelRole(this.cfg.model, role, undefined, lookupCapabilities);
  }

  /** Replace the live settings (after config/auth were rewritten on disk). */
  reload(cfg: MonadConfig, auth: MonadAuth | null): void {
    this.cfg = cfg;
    this.auth = auth ?? structuredClone(EMPTY_AUTH);
  }

  /** Scan `dir` for `.js` atom pack files and register any providers found. The daemon wires
   *  live re-scan-on-change through the shared WatchService, not here. */
  discoverProviders(dir: string): Promise<DiscoverResult> {
    return this.registry.discover(dir);
  }

  private reportCredential(
    providerId: string,
    credId: string,
    ok: boolean,
    err?: { code?: string; message?: string }
  ): void {
    const cred = this.auth.credentialPool[providerId]?.find((c) => c.id === credId);
    if (!cred) return;

    cred.requestCount += 1;
    cred.lastStatus = ok ? 'ok' : 'error';
    cred.lastStatusAt = new Date().toISOString();
    if (ok) {
      cred.lastErrorCode = null;
      cred.lastErrorMessage = null;
      cred.lastErrorReason = null;
    } else {
      cred.lastErrorCode = err?.code ?? null;
      cred.lastErrorMessage = err?.message ?? null;
    }

    this.scheduleSave();
  }

  /** Coalesce frequent updates into one write — generation reports per round. */
  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.auth.updatedAt = new Date().toISOString();
      saveAuth(this.authPath, this.auth).catch(() => {
        // Best-effort: a failed health write must never break generation.
      });
    }, SAVE_DEBOUNCE_MS);
    // Don't keep the process alive solely for a pending health write.
    this.saveTimer.unref?.();
  }
}

function credentialToHandle(cred: Credential): ProviderCredential {
  return {
    id: cred.id,
    accessToken: cred.accessToken,
    authType: cred.authType,
    baseUrl: cred.baseUrl,
    priority: cred.priority
  };
}
