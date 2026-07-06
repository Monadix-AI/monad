import type { ModelProfileRoutes, ModelRoles, SetProfileRequest } from '@monad/protocol';
import type { ModelContext } from '@/handlers/settings/model/context.ts';

import { HandlerError } from '@/handlers/handler-error.ts';
import { profileToView, viewToProfile } from '@/handlers/settings/model/utils.ts';

const DEFAULT_PROFILE_ALIAS = 'default';

function specFromRoute(route: { provider: string; modelId: string } | undefined): string | undefined {
  return route ? `${route.provider}:${route.modelId}` : undefined;
}

function routeFromSpec(spec: string | undefined): { provider: string; modelId: string } | undefined {
  if (!spec) return undefined;
  const i = spec.indexOf(':');
  if (i <= 0) return undefined;
  return { provider: spec.slice(0, i), modelId: spec.slice(i + 1) };
}

export function createProfilesHandlers(ctx: ModelContext) {
  return {
    async listProfiles() {
      const { cfg } = await ctx.read();
      return {
        profiles: cfg.model.profiles.map(profileToView),
        defaultAlias: cfg.model.default || DEFAULT_PROFILE_ALIAS
      };
    },

    async getProfile({ alias }: { alias: string }) {
      const { cfg } = await ctx.read();
      const profile = cfg.model.profiles.find((p) => p.alias === alias);
      if (!profile) throw new HandlerError('not_found', `model: unknown profile "${alias}"`);
      return { profile: profileToView(profile) };
    },

    async setProfile({ profile }: SetProfileRequest) {
      const { cfg, auth } = await ctx.read();

      // Guard against obviously wrong default models (e.g. image/video-only, embeddings).
      // Only enforced when the catalog has data; unknown models are allowed through and will
      // surface errors at runtime if they genuinely can't handle text.
      if (profile.routes.chat.provider && profile.routes.chat.modelId) {
        const caps = ctx.lookupCapabilities(profile.routes.chat.provider, profile.routes.chat.modelId);
        if (caps !== undefined) {
          const isLLM = !!caps.input?.includes('text') && !!caps.output?.includes('text');
          if (!isLLM) {
            throw new HandlerError(
              'invalid',
              `model: "${profile.routes.chat.modelId}" is not a text chat model — ` +
                'it must support text input and text output as the default model'
            );
          }
        }
      }

      const next = viewToProfile(profile);
      const i = cfg.model.profiles.findIndex((p) => p.alias === next.alias);
      if (i >= 0) cfg.model.profiles[i] = next;
      else cfg.model.profiles.push(next);
      await ctx.commit(cfg, auth);
      return { ok: true as const };
    },

    async deleteProfile({ alias }: { alias: string }) {
      const { cfg, auth } = await ctx.read();
      const effectiveDefault = cfg.model.default || DEFAULT_PROFILE_ALIAS;
      if (alias === effectiveDefault) {
        throw new HandlerError('conflict', 'model: default profile cannot be deleted');
      }
      const agent = cfg.agent.agents.find((agent) => agent.modelAlias === alias || agent.model === alias);
      if (agent) {
        throw new HandlerError(
          'conflict',
          `model: profile "${alias}" is used by agent "${agent.name}" and cannot be deleted`
        );
      }
      cfg.model.profiles = cfg.model.profiles.filter((p) => p.alias !== alias);
      await ctx.commit(cfg, auth);
      return { ok: true as const };
    },

    async renameProfile({ alias, nextAlias }: { alias: string; nextAlias: string }) {
      const { cfg, auth } = await ctx.read();
      const trimmed = nextAlias.trim();
      if (!trimmed) throw new HandlerError('invalid', 'model: profile alias cannot be empty');
      if (trimmed === alias) return { ok: true as const };

      const profile = cfg.model.profiles.find((profile) => profile.alias === alias);
      if (!profile) throw new HandlerError('not_found', `model: unknown profile "${alias}"`);
      if (cfg.model.profiles.some((profile) => profile.alias === trimmed)) {
        throw new HandlerError('conflict', `model: profile "${trimmed}" already exists`);
      }

      profile.alias = trimmed;
      if ((cfg.model.default || DEFAULT_PROFILE_ALIAS) === alias) cfg.model.default = trimmed;
      for (const agent of cfg.agent.agents) {
        if (agent.modelAlias === alias) agent.modelAlias = trimmed;
        if (agent.model === alias) agent.model = trimmed;
      }

      await ctx.commit(cfg, auth);
      return { ok: true as const };
    },

    async getDefaultProfile() {
      const { cfg } = await ctx.read();
      return { alias: cfg.model.default || DEFAULT_PROFILE_ALIAS };
    },

    async setDefaultProfile({ alias }: { alias: string }) {
      const { cfg, auth } = await ctx.read();
      if (!cfg.model.profiles.some((p) => p.alias === alias)) {
        throw new Error(`model: unknown profile "${alias}"`);
      }
      cfg.model.default = alias;
      await ctx.commit(cfg, auth);
      return { ok: true as const };
    },

    /** Non-chat model-role assignments. chat = the default profile. */
    async getRoles() {
      const { cfg } = await ctx.read();
      const roles: ModelProfileRoutes | undefined = cfg.model.profiles.find(
        (profile) => profile.alias === (cfg.model.default || DEFAULT_PROFILE_ALIAS)
      )?.routes;
      return {
        roles: {
          ...(specFromRoute(roles?.vision) ? { vision: specFromRoute(roles?.vision) } : {}),
          ...(specFromRoute(roles?.image) ? { image: specFromRoute(roles?.image) } : {}),
          ...(specFromRoute(roles?.video) ? { video: specFromRoute(roles?.video) } : {}),
          ...(specFromRoute(roles?.speech) ? { speech: specFromRoute(roles?.speech) } : {}),
          ...(specFromRoute(roles?.transcription) ? { transcription: specFromRoute(roles?.transcription) } : {}),
          ...(specFromRoute(roles?.embedding) ? { embedding: specFromRoute(roles?.embedding) } : {}),
          ...(specFromRoute(roles?.memory) ? { memory: specFromRoute(roles?.memory) } : {})
        }
      };
    },

    /** Replace the non-chat role assignments. */
    async setRoles({ roles }: { roles: ModelRoles }) {
      const { cfg, auth } = await ctx.read();
      const profile = cfg.model.profiles.find((p) => p.alias === (cfg.model.default || DEFAULT_PROFILE_ALIAS));
      if (!profile)
        throw new Error(`model: default profile "${cfg.model.default || DEFAULT_PROFILE_ALIAS}" is not configured`);
      profile.routes = {
        chat: profile.routes.chat,
        fast: profile.routes.fast,
        vision: routeFromSpec(roles.vision),
        image: routeFromSpec(roles.image),
        video: routeFromSpec(roles.video),
        speech: routeFromSpec(roles.speech),
        transcription: routeFromSpec(roles.transcription),
        embedding: routeFromSpec(roles.embedding),
        memory: routeFromSpec(roles.memory)
      };
      await ctx.commit(cfg, auth);
      return { ok: true as const };
    }
  };
}
