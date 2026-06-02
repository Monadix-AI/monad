import type { MonadConfig } from '@monad/environment';
import type { ModelModalities, ModelRole, ModelRoles, SandboxMode } from '@monad/protocol';

export const DEFAULT_PROFILE_ALIAS = 'default';

export type CapabilityLookup = (provider: string, modelId: string) => ModelModalities | undefined;

/** Resolve a model role to its effective model spec, applying the fallback chain in ONE place
 *  (image/speech/transcription/vision tools + the embedding pipeline all go through here):
 *   - chat      → the selected profile alias, defaulting to "default"
 *   - vision    → profile.routes.vision ?? default model (only if known to cover image input, else runtime error)
 *   - image     → profile.routes.image ?? default model (only if known to cover image output, else runtime error)
 *   - speech    → profile.routes.speech ?? default model (only if known to cover speech output, else runtime error)
 *   - transcription → profile.routes.transcription ?? default model (only if known to transcribe audio, else runtime error)
 *   - fast      → profile.routes.fast ?? default model
 *   - embedding → profile.routes.embedding (no fallback; undefined ⇒ semantic search degrades to keyword)
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
  const routes = profile?.routes;

  const routeSpec = (route: { provider: string; modelId: string } | undefined): string | undefined =>
    route ? `${route.provider}:${route.modelId}` : undefined;

  const defaultCovers = (check: (c: ModelModalities) => boolean): boolean => {
    if (!routes?.chat.provider || !routes.chat.modelId) return false;
    const caps = lookupCapabilities?.(routes.chat.provider, routes.chat.modelId);
    if (caps === undefined) {
      throw new Error(
        `model: cannot determine capabilities for ${routes.chat.provider}:${routes.chat.modelId} — ` +
          'the provider did not report them and the catalog has no entry; set the role model explicitly'
      );
    }
    return check(caps);
  };

  switch (role) {
    case 'chat':
      return profile ? profileAlias : undefined;

    case 'vision': {
      const explicit = routeSpec(routes?.vision);
      if (explicit) return explicit;
      if (!lookupCapabilities) return profileAlias || undefined; // legacy: no capability check
      if (defaultCovers((c) => !!c.input?.includes('image'))) return profileAlias || undefined;
      throw new Error(
        'model: vision role requires a model that accepts image input; ' +
          `the default model "${routes?.chat.modelId}" does not — set a vision model explicitly`
      );
    }

    case 'image': {
      const explicit = routeSpec(routes?.image);
      if (explicit) return explicit;
      if (!lookupCapabilities) return undefined; // legacy: no fallback
      if (defaultCovers((c) => c.kind === 'image' || !!c.output?.includes('image'))) return profileAlias || undefined;
      throw new Error(
        'model: image-generation role requires a model that generates images; ' +
          `the default model "${routes?.chat.modelId}" does not — set an image model explicitly`
      );
    }

    case 'speech': {
      const explicit = routeSpec(routes?.speech);
      if (explicit) return explicit;
      if (!lookupCapabilities) return undefined; // legacy: no fallback
      if (defaultCovers((c) => c.kind === 'speech' || !!c.output?.includes('speech'))) return profileAlias || undefined;
      throw new Error(
        'model: speech role requires a model that generates audio; ' +
          `the default model "${routes?.chat.modelId}" does not — set a speech model explicitly`
      );
    }

    case 'transcription': {
      const explicit = routeSpec(routes?.transcription);
      if (explicit) return explicit;
      if (!lookupCapabilities) return undefined; // legacy: no fallback
      if (defaultCovers((c) => c.kind === 'transcription' || !!c.output?.includes('transcription'))) {
        return profileAlias || undefined;
      }
      throw new Error(
        'model: transcription role requires a model that transcribes audio; ' +
          `the default model "${routes?.chat.modelId}" does not — set a transcription model explicitly`
      );
    }

    case 'video':
      // Video generation has no default fallback — a chat default never produces video, so the
      // role only resolves when assigned explicitly. (No runtime consumer yet; reserved.)
      return routeSpec(routes?.video);

    case 'embedding':
      return routeSpec(routes?.embedding);

    case 'fast':
      return routeSpec(routes?.fast) ?? (profileAlias || undefined);

    case 'memory':
      // The memory extractor/consolidator. A cheap model is ideal; falls back to the chat default.
      return routeSpec(routes?.memory) ?? (profileAlias || undefined);
  }
}

/** Resolve a role for a specific agent: a per-agent `roles` override wins over the profile roles. */
export function resolveAgentModelRole(
  model: MonadConfig['model'],
  agentRoles: ModelRoles | undefined,
  role: ModelRole
): string | undefined {
  if (role !== 'chat' && role !== 'fast') {
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
