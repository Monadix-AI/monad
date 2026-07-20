import type { Credential, Provider } from '@monad/environment';
import type { ModelInfo, PatchProviderRequest, ProviderView, SetProviderRequest } from '@monad/protocol';
import type { ModelContext } from '#/handlers/settings/model/context.ts';

import { mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { providerSchema } from '@monad/environment';
import { modelInfoSchema } from '@monad/protocol';
import { z } from 'zod';

import { listProviderModels } from '#/agent/index.ts';
import { HandlerError } from '#/handlers/handler-error.ts';
import {
  credentialToHandle,
  enrichModelInfo,
  providerToResolved,
  providerToView,
  viewToProvider
} from '#/handlers/settings/model/utils.ts';

interface ProviderModelCacheEntry {
  providerType: Provider['type'];
  baseUrl?: string;
  credentialId: string;
  extra?: Record<string, string>;
  updatedAt: string;
  models: ModelInfo[];
}

interface ProviderModelCacheFile {
  providers: Record<string, ProviderModelCacheEntry>;
}

const providerModelCacheFileSchema: z.ZodType<ProviderModelCacheFile> = z.object({
  providers: z.record(
    z.string(),
    z.object({
      providerType: providerSchema.shape.type,
      baseUrl: z.string().optional(),
      credentialId: z.string(),
      extra: z.record(z.string(), z.string()).optional(),
      updatedAt: z.string(),
      models: z.array(modelInfoSchema)
    })
  )
});

export function createProvidersHandlers(ctx: ModelContext) {
  const refreshing = new Set<string>();

  async function fetchAndCacheModels(provider: Provider, cred: Credential): Promise<ModelInfo[]> {
    const models = await listProviderModels(providerToResolved(provider), credentialToHandle(cred), ctx.registry);
    const { cfg } = await ctx.read();
    const currentProvider = cfg.model.providers.find((p) => p.id === provider.id);
    if (!currentProvider || !sameProviderCacheScope(currentProvider, provider)) return models;

    const enriched = models.map((model) => enrichModelInfo(ctx, cfg, currentProvider, model));
    const cache = await readProviderModelCache(ctx.providerModelCachePath);
    cache.providers[provider.id] = {
      ...providerCacheScope(currentProvider, cred.id),
      updatedAt: new Date().toISOString(),
      models: enriched
    };
    await writeProviderModelCache(ctx.providerModelCachePath, cache);
    return enriched;
  }

  function refreshInBackground(provider: Provider, cred: Parameters<typeof fetchAndCacheModels>[1]): void {
    if (refreshing.has(provider.id)) return;
    refreshing.add(provider.id);
    void fetchAndCacheModels(provider, cred)
      .catch(() => {
        // Keep serving the last successful list; provider list failures should not blank the UI.
      })
      .finally(() => refreshing.delete(provider.id));
  }

  return {
    async listProviders() {
      const { cfg } = await ctx.read();
      return { providers: cfg.model.providers.map(providerToView) };
    },

    async getProvider({ id }: { id: string }) {
      const { cfg } = await ctx.read();
      const provider = cfg.model.providers.find((p) => p.id === id);
      if (!provider) throw new HandlerError('not_found', `model: unknown provider "${id}"`);
      return { provider: providerToView(provider) };
    },

    async setProvider({ provider }: SetProviderRequest) {
      const { cfg, auth } = await ctx.read();
      const next = viewToProvider(provider);
      const i = cfg.model.providers.findIndex((provider) => provider.id === next.id);
      const previous = i >= 0 ? cfg.model.providers[i] : undefined;
      if (i >= 0) cfg.model.providers[i] = next;
      else cfg.model.providers.push(next);
      if (previous && !sameProviderCacheScope(previous, next)) {
        await deleteProviderModelCacheEntry(ctx.providerModelCachePath, next.id);
      }
      await ctx.commit(cfg, auth);
      return { ok: true as const };
    },

    // Partial update: merges the patch onto the currently stored provider, then reuses the same
    // persistence + cache-invalidation path as setProvider (full replace).
    async patchProvider({ id, patch }: { id: string; patch: PatchProviderRequest }) {
      const { cfg, auth } = await ctx.read();
      const i = cfg.model.providers.findIndex((provider) => provider.id === id);
      const previous = i >= 0 ? cfg.model.providers[i] : undefined;
      if (i < 0 || !previous) throw new HandlerError('not_found', `model: unknown provider "${id}"`);
      const mergedView: ProviderView = { ...providerToView(previous), ...patch, id };
      const next = viewToProvider(mergedView);
      cfg.model.providers[i] = next;
      if (!sameProviderCacheScope(previous, next)) {
        await deleteProviderModelCacheEntry(ctx.providerModelCachePath, next.id);
      }
      await ctx.commit(cfg, auth);
      return { ok: true as const };
    },

    async setProviderEnabled({ id, enabled }: { id: string; enabled: boolean }) {
      const { cfg, auth } = await ctx.read();
      const i = cfg.model.providers.findIndex((provider) => provider.id === id);
      const previous = i >= 0 ? cfg.model.providers[i] : undefined;
      if (i < 0 || !previous) throw new HandlerError('not_found', `model: unknown provider "${id}"`);
      cfg.model.providers[i] = { ...previous, enabled };
      await ctx.commit(cfg, auth);
      return { ok: true as const };
    },

    async deleteProvider({ id }: { id: string }) {
      const { cfg, auth } = await ctx.read();
      const profile = cfg.model.profiles.find((profile) =>
        Object.values(profile.routes).some((route) => route?.provider === id)
      );
      if (profile) {
        throw new HandlerError(
          'conflict',
          `model: provider "${id}" is used by profile "${profile.alias}" and cannot be deleted`
        );
      }
      cfg.model.providers = cfg.model.providers.filter((provider) => provider.id !== id);
      delete auth.credentialPool[id];
      await deleteProviderModelCacheEntry(ctx.providerModelCachePath, id);
      await ctx.commit(cfg, auth);
      return { ok: true as const };
    },

    async listModels({ providerId }: { providerId: string }) {
      const { cfg, auth } = await ctx.read();
      const provider = cfg.model.providers.find((p) => p.id === providerId);
      const cred = auth.credentialPool[providerId]?.[0];
      if (!provider || !cred) return { providerId, models: [] };
      const cached = (await readProviderModelCache(ctx.providerModelCachePath)).providers[providerId];
      if (cached && isCacheEntryFor(cached, provider, cred.id)) {
        refreshInBackground(provider, cred);
        return { providerId, models: cached.models };
      }
      const enriched = await fetchAndCacheModels(provider, cred);
      return { providerId, models: enriched };
    },

    /** The provider catalog (labels, default base URLs, key hints, extra fields) assembled from the
     *  registered providers' self-describing descriptors — first- and third-party alike. The web
     *  wizard and CLI read this instead of a hardcoded list. */
    providerCatalog() {
      const providers = ctx.registry
        .types()
        .map((t) => ctx.registry.get(t)?.descriptor)
        .filter((d): d is NonNullable<typeof d> => d != null);
      return { providers };
    }
  };
}

async function readProviderModelCache(path: string): Promise<ProviderModelCacheFile> {
  try {
    return providerModelCacheFileSchema.parse(await Bun.file(path).json());
  } catch (err) {
    if (isMissingFile(err)) return { providers: {} };
    return { providers: {} };
  }
}

async function writeProviderModelCache(path: string, cache: ProviderModelCacheFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await Bun.write(tmp, `${JSON.stringify(cache, null, 2)}\n`);
  await rename(tmp, path);
}

async function deleteProviderModelCacheEntry(path: string, providerId: string): Promise<void> {
  const cache = await readProviderModelCache(path);
  if (!(providerId in cache.providers)) return;
  delete cache.providers[providerId];
  await writeProviderModelCache(path, cache);
}

function providerCacheScope(provider: Pick<Provider, 'type' | 'baseUrl' | 'extra'>, credentialId: string) {
  return {
    providerType: provider.type,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    credentialId,
    ...(provider.extra ? { extra: provider.extra } : {})
  };
}

function sameProviderCacheScope(
  a: Pick<Provider, 'type' | 'baseUrl' | 'extra'>,
  b: Pick<Provider, 'type' | 'baseUrl' | 'extra'>
): boolean {
  return a.type === b.type && a.baseUrl === b.baseUrl && stableRecordKey(a.extra) === stableRecordKey(b.extra);
}

function isCacheEntryFor(
  entry: ProviderModelCacheEntry,
  provider: Pick<Provider, 'type' | 'baseUrl' | 'extra'>,
  credentialId: string
): boolean {
  return (
    entry.providerType === provider.type &&
    entry.baseUrl === provider.baseUrl &&
    entry.credentialId === credentialId &&
    stableRecordKey(entry.extra) === stableRecordKey(provider.extra)
  );
}

function stableRecordKey(record: Record<string, string> | undefined): string {
  if (!record) return '';
  return JSON.stringify(Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b))));
}

function isMissingFile(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'ENOENT';
}
