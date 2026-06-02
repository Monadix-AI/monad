import type { MonadConfig } from '@monad/home';
import type { ModelModalities, ModelRole, ModelRoles, SandboxMode } from '@monad/protocol';

export const DEFAULT_PROFILE_ALIAS = 'default';

export type CapabilityLookup = (provider: string, modelId: string) => ModelModalities | undefined;

/** Resolve a model role to its effective model spec, applying the fallback chain in ONE place
 *  (image/speech/vision tools + the embedding pipeline all go through here):
 *   - chat      → the selected profile alias, defaulting to "default"
 *   - vision    → profile.roles.vision ?? default model (if it covers image input, else runtime error)
 *   - image     → profile.roles.image ?? default model (if it covers image output, else runtime error)
 *   - speech    → profile.roles.speech ?? default model (if it covers audio output, else runtime error)
 *   - embedding → profile.roles.embedding (no fallback; undefined ⇒ semantic search degrades to keyword)
 *  When `lookupCapabilities` is provided the capability-based fallback is enforced; without it the
 *  legacy no-check behavior applies (e.g. callers that have no catalog access).
 *  Returns a profile alias (chat/vision) or a "providerId:modelId" spec, or undefined if unset. */
export function resolveModelRole(
  model: MonadConfig['model'],
  role: ModelRole,
  profileAlias = model.default || DEFAULT_PROFILE_ALIAS,
  lookupCapabilities?: CapabilityLookup
): string | undefined {
  const profile = model.profiles.find((p) => p.alias === profileAlias);
  const roles = profile?.roles ?? {};

  const defaultCovers = (check: (c: ModelModalities) => boolean): boolean => {
    if (!profile?.provider || !profile?.modelId) return false;
    const caps = lookupCapabilities?.(profile.provider, profile.modelId);
    if (caps === undefined) {
      throw new Error(
        `model: cannot determine capabilities for ${profile.provider}:${profile.modelId} — ` +
          'the provider did not report them and the catalog has no entry; set the role model explicitly'
      );
    }
    return check(caps);
  };

  switch (role) {
    case 'chat':
      return profile ? profileAlias : undefined;

    case 'vision': {
      if (roles.vision) return roles.vision;
      if (!lookupCapabilities) return profileAlias || undefined; // legacy: no capability check
      if (!profile?.provider || !profile?.modelId) return profileAlias || undefined;
      const caps = lookupCapabilities(profile.provider, profile.modelId);
      // Unknown capabilities → best-effort: let the default model try (most chat models accept
      // image input, and an unlisted/local model self-reports nothing). Only reject when we KNOW
      // it can't take images.
      if (caps === undefined || caps.input?.includes('image')) return profileAlias || undefined;
      throw new Error(
        'model: vision role requires a model that accepts image input; ' +
          `the default model "${profile?.modelId}" does not — set a vision model explicitly`
      );
    }

    case 'image': {
      if (roles.image) return roles.image;
      if (!lookupCapabilities) return undefined; // legacy: no fallback
      if (defaultCovers((c) => c.kind === 'image' || !!c.output?.includes('image'))) return profileAlias || undefined;
      throw new Error(
        'model: image-generation role requires a model that generates images; ' +
          `the default model "${profile?.modelId}" does not — set an image model explicitly`
      );
    }

    case 'speech': {
      if (roles.speech) return roles.speech;
      if (!lookupCapabilities) return undefined; // legacy: no fallback
      if (defaultCovers((c) => c.kind === 'speech' || !!c.output?.includes('audio'))) return profileAlias || undefined;
      throw new Error(
        'model: speech role requires a model that generates audio; ' +
          `the default model "${profile?.modelId}" does not — set a speech model explicitly`
      );
    }

    case 'video':
      // Video generation has no default fallback — a chat default never produces video, so the
      // role only resolves when assigned explicitly. (No runtime consumer yet; reserved.)
      return roles.video;

    case 'embedding':
      return roles.embedding;

    case 'memory':
      // The memory extractor/consolidator. A cheap model is ideal; falls back to the chat default.
      return roles.memory ?? (profileAlias || undefined);
  }
}

/** Resolve a role for a specific agent: a per-agent `roles` override wins over the profile roles. */
export function resolveAgentModelRole(
  model: MonadConfig['model'],
  agentRoles: ModelRoles | undefined,
  role: ModelRole
): string | undefined {
  if (role !== 'chat') {
    const override = agentRoles?.[role];
    if (override) return override;
  }
  return resolveModelRole(model, role);
}

/**
 * Resolve the sandbox mode that actually applies to an agent. The daemon-wide global
 * restriction, when enabled, wins over the agent's own setting — a ceiling an
 * individual agent cannot escape; otherwise the agent keeps its own mode.
 */
export function resolveEffectiveSandboxMode(
  perAgent: { mode: SandboxMode },
  global: { enabled: boolean; mode: SandboxMode }
): SandboxMode {
  return global.enabled ? global.mode : perAgent.mode;
}
