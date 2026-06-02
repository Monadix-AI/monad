import type { ProviderCredential } from '@monad/environment';
import type { AddCredentialRequest, TestConnectionRequest, TestCredentialRequest } from '@monad/protocol';
import type { ModelContext } from '#/handlers/settings/model/context.ts';

import { newId } from '@monad/protocol';

import { fetchProviderModels } from '#/agent/index.ts';
import { HandlerError } from '#/handlers/handler-error.ts';
import {
  credentialToHandle,
  credentialToView,
  enrichModelInfo,
  providerToResolved
} from '#/handlers/settings/model/utils.ts';

export function createCredentialsHandlers(ctx: ModelContext) {
  return {
    async listCredentials({ providerId }: { providerId: string }) {
      const { cfg } = await ctx.read();
      const list = cfg.model.providers.find((provider) => provider.id === providerId)?.credentials ?? [];
      return { providerId, credentials: list.map(credentialToView) };
    },

    async addCredential(req: AddCredentialRequest) {
      const { cfg } = await ctx.read();
      const provider = cfg.model.providers.find((candidate) => candidate.id === req.providerId);
      if (!provider) throw new HandlerError('not_found', `unknown provider "${req.providerId}"`);
      const pool = provider.credentials as ProviderCredential[];
      const id = newId('cred');
      const nextPriority = req.priority ?? pool.length;
      pool.push({
        id,
        label: req.label,
        authType: req.authType,
        priority: nextPriority,
        source: 'manual',
        accessToken: req.accessToken,
        baseUrl: req.baseUrl,
        lastStatus: 'unknown',
        lastStatusAt: null,
        lastErrorCode: null,
        lastErrorReason: null,
        lastErrorMessage: null,
        lastErrorResetAt: null,
        requestCount: 0
      });
      await ctx.commit(cfg);
      return { id };
    },

    async deleteCredential({ providerId, credentialId }: { providerId: string; credentialId: string }) {
      const { cfg } = await ctx.read();
      const provider = cfg.model.providers.find((candidate) => candidate.id === providerId);
      if (provider) provider.credentials = provider.credentials.filter((credential) => credential.id !== credentialId);
      await ctx.commit(cfg);
      return { ok: true as const };
    },

    async testCredential({ providerId, credentialId }: TestCredentialRequest) {
      const { cfg } = await ctx.read();
      const provider = cfg.model.providers.find((p) => p.id === providerId);
      const cred = provider?.credentials.find((credential) => credential.id === credentialId);
      if (!provider) return { ok: false, error: `unknown provider "${providerId}"` };
      if (!cred) return { ok: false, error: `unknown credential "${credentialId}"` };

      const startedAt = Date.now();
      try {
        await fetchProviderModels(providerToResolved(provider), credentialToHandle(cred), ctx.registry);
        return { ok: true as const, latencyMs: Date.now() - startedAt };
      } catch (err) {
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err)
        };
      }
    },

    async testConnection({ provider, accessToken }: TestConnectionRequest) {
      const { cfg } = await ctx.read();
      const resolved = {
        id: provider.id || 'probe',
        type: provider.type,
        baseUrl: provider.baseUrl,
        extra: provider.extra
      };
      const handle = {
        id: 'probe',
        accessToken,
        authType: 'api_key' as const,
        baseUrl: provider.baseUrl,
        priority: 0
      };

      const startedAt = Date.now();
      try {
        const models = await fetchProviderModels(resolved, handle, ctx.registry);
        return {
          ok: true as const,
          latencyMs: Date.now() - startedAt,
          models: models.map((model) => enrichModelInfo(ctx, cfg, resolved, model))
        };
      } catch (err) {
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err)
        };
      }
    }
  };
}
