import type { SetProviderRequest } from '@monad/protocol';
import type { ModelContext } from '@/handlers/settings/model/context.ts';

import { listProviderModels } from '@/agent/index.ts';
import {
  credentialToHandle,
  providerToResolved,
  providerToView,
  viewToProvider
} from '@/handlers/settings/model/utils.ts';

export function createProvidersHandlers(ctx: ModelContext) {
  return {
    async listProviders() {
      const { cfg } = await ctx.read();
      return { providers: cfg.model.providers.map(providerToView) };
    },

    async setProvider({ provider }: SetProviderRequest) {
      const { cfg, auth } = await ctx.read();
      const next = viewToProvider(provider);
      const i = cfg.model.providers.findIndex((provider) => provider.id === next.id);
      if (i >= 0) cfg.model.providers[i] = next;
      else cfg.model.providers.push(next);
      await ctx.commit(cfg, auth);
      return { ok: true as const };
    },

    async deleteProvider({ id }: { id: string }) {
      const { cfg, auth } = await ctx.read();
      cfg.model.providers = cfg.model.providers.filter((provider) => provider.id !== id);
      await ctx.commit(cfg, auth);
      return { ok: true as const };
    },

    async listModels({ providerId }: { providerId: string }) {
      const { cfg, auth } = await ctx.read();
      const provider = cfg.model.providers.find((p) => p.id === providerId);
      const cred = auth.credentialPool[providerId]?.[0];
      if (!provider || !cred) return { providerId, models: [] };
      const models = await listProviderModels(providerToResolved(provider), credentialToHandle(cred), ctx.registry);
      // Prefer the provider's own metadata (pricing/modalities it self-reports — authoritative);
      // fall back to the models.dev catalog by id. Price uses an EXACT id match (a fuzzy version
      // could show a wrong number); modalities tolerate the catalog's suffix fallback (stable
      // across point versions).
      const enriched = models.map((m) => {
        const price = m.price ?? ctx.lookupPriceExact(provider.type, m.id);
        const inferred = m.modalities ?? ctx.lookupCapabilities(provider.type, m.id);
        // A manual kind override (config model.kinds) is the final authority — it can correct or
        // supply a kind the layered inference missed (e.g. an embedding id the heuristic won't match).
        const override = cfg.model.kinds[`${provider.id}:${m.id}`];
        const modalities = override ? { ...(inferred ?? {}), kind: override } : inferred;
        return {
          id: m.id,
          label: m.label,
          ...(price && Object.keys(price).length > 0 ? { price } : {}),
          ...(modalities ? { modalities } : {})
        };
      });
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
