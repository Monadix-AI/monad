import type { ModelRoles, SetProfileRequest } from '@monad/protocol';
import type { ModelContext } from '@/handlers/settings/model/context.ts';

import { HandlerError } from '@/handlers/handler-error.ts';
import { profileToView, viewToProfile } from '@/handlers/settings/model/utils.ts';

const DEFAULT_PROFILE_ALIAS = 'default';

export function createProfilesHandlers(ctx: ModelContext) {
  return {
    async listProfiles() {
      const { cfg } = await ctx.read();
      return {
        profiles: cfg.model.profiles.map(profileToView),
        defaultAlias: cfg.model.default || DEFAULT_PROFILE_ALIAS
      };
    },

    async setProfile({ profile }: SetProfileRequest) {
      const { cfg, auth } = await ctx.read();

      // Guard against obviously wrong default models (e.g. image/video-only, embeddings).
      // Only enforced when the catalog has data; unknown models are allowed through and will
      // surface errors at runtime if they genuinely can't handle text.
      if (profile.provider && profile.modelId) {
        const caps = ctx.lookupCapabilities(profile.provider, profile.modelId);
        if (caps !== undefined) {
          const isLLM = !!caps.input?.includes('text') && !!caps.output?.includes('text');
          if (!isLLM) {
            throw new HandlerError(
              'invalid',
              `model: "${profile.modelId}" is not a text chat model — ` +
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
        throw new Error('model: default profile cannot be deleted');
      }
      cfg.model.profiles = cfg.model.profiles.filter((p) => p.alias !== alias);
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

    /** Non-chat model-role assignments (vision/image/speech/embedding). chat = the default profile. */
    async getRoles() {
      const { cfg } = await ctx.read();
      const roles =
        cfg.model.profiles.find((profile) => profile.alias === (cfg.model.default || DEFAULT_PROFILE_ALIAS))?.roles ??
        {};
      return {
        roles: {
          ...(roles.vision ? { vision: roles.vision } : {}),
          ...(roles.image ? { image: roles.image } : {}),
          ...(roles.speech ? { speech: roles.speech } : {}),
          ...(roles.embedding ? { embedding: roles.embedding } : {})
        }
      };
    },

    /** Replace the non-chat role assignments. */
    async setRoles({ roles }: { roles: ModelRoles }) {
      const { cfg, auth } = await ctx.read();
      const profile = cfg.model.profiles.find((p) => p.alias === (cfg.model.default || DEFAULT_PROFILE_ALIAS));
      if (!profile)
        throw new Error(`model: default profile "${cfg.model.default || DEFAULT_PROFILE_ALIAS}" is not configured`);
      profile.roles = roles;
      await ctx.commit(cfg, auth);
      return { ok: true as const };
    }
  };
}
