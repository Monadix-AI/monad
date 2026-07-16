import type { FallbackTargetView, ModelRole } from '@monad/protocol';
import type { ModelCall, ProviderCredential, ResolvedProviderConfig } from '@monad/sdk-atom';
import type { GenerationParams, ModelRequest } from '../index.ts';
import type { ModelProvider, ModelProviderRegistry } from '../provider.ts';
import type { GatewayDeps } from './index.ts';

export interface ResolvedProfile {
  alias: string;
  routes: Partial<Record<ModelRole, { provider: string; modelId: string }>> & {
    chat: { provider: string; modelId: string };
  };
  params: GenerationParams;
  routeParams?: Partial<Record<ModelRole, GenerationParams>>;
  fallbacks: FallbackTargetView[];
}

// A single concrete attempt: a fully-resolved provider + model + params.
export interface Attempt {
  provider: string;
  modelId: string;
  params: GenerationParams;
}

/** Credentials eligible for model inference — excludes admin keys, which can't make inference
 *  requests and are reserved for admin-level APIs (rate limits, usage reports). */
export function modelCreds(deps: GatewayDeps, providerId: string): ProviderCredential[] {
  return deps.credentialsFor(providerId).filter((c) => c.authType !== 'admin_api_key');
}

export function resolveProvider(
  deps: GatewayDeps,
  registry: ModelProviderRegistry,
  providerId: string
): { provider: ResolvedProviderConfig; impl: ModelProvider } {
  const provider = deps.providers.find((u) => u.id === providerId);
  if (!provider) throw new Error(`gateway: unknown provider "${providerId}"`);
  const impl = registry.get(provider.type);
  if (!impl) throw new Error(`gateway: no provider registered for provider type "${provider.type}"`);
  return { provider, impl };
}

export function buildCall(
  deps: GatewayDeps,
  req: ModelRequest,
  attempt: Attempt,
  provider: ResolvedProviderConfig,
  cred: ProviderCredential
): ModelCall {
  return {
    modelId: attempt.modelId,
    messages: req.messages,
    ...(req.tools ? { tools: req.tools } : {}),
    ...(deps.searchToolProvider ? { searchToolProvider: deps.searchToolProvider } : {}),
    params: attempt.params,
    provider,
    credential: cred,
    fetch: deps.fetch,
    ...(req.sessionId ? { sessionId: req.sessionId } : {}),
    ...(req.maxThinkingTokens ? { maxThinkingTokens: req.maxThinkingTokens } : {}),
    ...(req.signal ? { signal: req.signal } : {})
  };
}

export function buildChain(deps: GatewayDeps, req: ModelRequest): Attempt[] {
  const spec = req.model || deps.defaultProfile;
  if (!spec) throw new Error('gateway: no model specified and no default profile configured');

  // Raw "providerId:modelId" spec — bypasses profiles, no fallbacks.
  const rawSep = spec.indexOf(':');
  if (rawSep > 0) {
    const provider = spec.slice(0, rawSep);
    const modelId = spec.slice(rawSep + 1);
    const routeParams = paramsForRoute(deps, provider, modelId);
    return [{ provider, modelId, params: mergeParams(routeParams ?? {}, req.params) }];
  }

  const chain: Attempt[] = [];
  expandProfile(deps, spec, req.params, new Set(), chain, true);
  return chain;
}

function expandProfile(
  deps: GatewayDeps,
  alias: string,
  overrideParams: GenerationParams | undefined,
  visited: Set<string>,
  out: Attempt[],
  isPrimary: boolean
): void {
  if (visited.has(alias)) return; // guard against fallback cycles
  visited.add(alias);

  const profile = deps.profiles.find((p) => p.alias === alias);
  if (!profile) {
    // A missing primary profile is a hard error; a missing fallback is skipped.
    if (isPrimary) throw new Error(`gateway: unknown model profile "${alias}"`);
    return;
  }

  out.push({
    provider: profile.routes.chat.provider,
    modelId: profile.routes.chat.modelId,
    params: isPrimary
      ? mergeParams(mergeParams(profile.params, profile.routeParams?.chat), overrideParams)
      : mergeParams(profile.params, profile.routeParams?.chat)
  });

  for (const fb of profile.fallbacks) {
    if ('profile' in fb) expandProfile(deps, fb.profile, undefined, visited, out, false);
    else out.push({ provider: fb.provider, modelId: fb.modelId, params: {} });
  }
}

function paramsForRoute(deps: GatewayDeps, provider: string, modelId: string): GenerationParams | undefined {
  for (const profile of deps.profiles) {
    for (const role of Object.keys(profile.routes) as ModelRole[]) {
      if (role === 'chat') continue;
      const route = profile.routes[role];
      if (route?.provider === provider && route.modelId === modelId) return profile.routeParams?.[role];
    }
  }
  return undefined;
}

function mergeParams(base: GenerationParams, over: GenerationParams | undefined): GenerationParams {
  if (!over) return base;
  const merged: GenerationParams = { ...base };
  if (over.temperature !== undefined) merged.temperature = over.temperature;
  if (over.maxTokens !== undefined) merged.maxTokens = over.maxTokens;
  if (over.topP !== undefined) merged.topP = over.topP;
  if (over.reasoningEffort !== undefined) merged.reasoningEffort = over.reasoningEffort;
  return merged;
}

export function errInfo(err: unknown): { code?: string; message?: string } {
  const e = err as { statusCode?: number; code?: string; message?: string } | undefined;
  return {
    code: e?.code ?? (e?.statusCode !== undefined ? String(e.statusCode) : undefined),
    message: e?.message
  };
}
