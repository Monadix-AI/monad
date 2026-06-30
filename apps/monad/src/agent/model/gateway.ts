// Intentionally free of any @monad/home dependency: the daemon reads config.json/auth.json and
// injects already-resolved settings plus a `credentialsFor` accessor, so agent-core never touches
// the filesystem. Also free of ai-sdk: the gateway resolves a profile → provider + credential and
// drives the provider through the ai-sdk-free ModelProvider contract; ai-sdk lives in @monad/atoms.

import type { FallbackTargetView, ModelRole } from '@monad/protocol';
import type {
  ImageCall,
  ModelCall,
  ModelChunk,
  ModelInfo,
  ProviderCredential,
  ResolvedProviderConfig,
  SpeechCall,
  UsageLimits
} from '@monad/sdk-atom';
import type {
  EmbedResult,
  GenerationParams,
  ImageRequest,
  ImageResult,
  ModelRequest,
  ModelResult,
  ModelRouter,
  SpeechRequest,
  SpeechResult
} from './index.ts';
import type { ModelProvider } from './provider.ts';

import { createLogger } from '@monad/logger';
import { openAiPrice } from '@monad/protocol';

import { withResolvedModel } from './index.ts';
import { ModelProviderRegistry } from './provider.ts';

export type { ProviderCredential, ResolvedProviderConfig } from '@monad/sdk-atom';

interface ResolvedProfile {
  alias: string;
  routes: Partial<Record<ModelRole, { provider: string; modelId: string }>> & {
    chat: { provider: string; modelId: string };
  };
  params: GenerationParams;
  routeParams?: Partial<Record<ModelRole, GenerationParams>>;
  fallbacks: FallbackTargetView[];
}

export interface GatewayDeps {
  providers: ResolvedProviderConfig[];
  profiles: ResolvedProfile[];
  /** Profile alias used when a request doesn't name one. */
  defaultProfile: string;
  /** Live search-tool provider preference from config.agent.tools.webSearch.provider. */
  searchToolProvider?: 'auto' | 'native' | 'brave' | 'ddgs';
  /** Resolved embedding model spec ("providerId:modelId" or profile alias). Absent ⇒ no
   *  embedding role configured; `embed()` throws and semantic search degrades to keyword. */
  embeddingModel?: string;
  /** Credentials for an provider id, best-first (caller sorts by priority asc). */
  credentialsFor(providerId: string): ProviderCredential[];
  /** Report an attempt outcome so auth.json health/usage can be updated. */
  reportCredential?(providerId: string, credId: string, ok: boolean, err?: { code?: string; message?: string }): void;
  /** Custom fetch — handy for offline tests / request interception. */
  fetch?: typeof fetch;
}

// A single concrete attempt: a fully-resolved provider + model + params.
interface Attempt {
  provider: string;
  modelId: string;
  params: GenerationParams;
}

const log = createLogger('model:gateway');

export class GatewayModelRouter implements ModelRouter {
  constructor(
    private readonly deps: GatewayDeps,
    private readonly registry: ModelProviderRegistry
  ) {}

  /** Credentials eligible for model inference — excludes admin keys, which can't make inference
   *  requests and are reserved for admin-level APIs (rate limits, usage reports). */
  private modelCreds(providerId: string): ProviderCredential[] {
    return this.deps.credentialsFor(providerId).filter((c) => c.authType !== 'admin_api_key');
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelChunk> {
    const errors: unknown[] = [];
    log.debug(
      {
        sessionId: req.sessionId,
        event: 'llm.stream.start',
        model: req.model,
        messages: req.messages,
        tools: req.tools
      },
      'llm stream start'
    );
    for (const attempt of this.buildChain(req)) {
      const creds = this.modelCreds(attempt.provider);
      if (creds.length === 0) {
        errors.push(new Error(`no credentials configured for provider "${attempt.provider}"`));
        continue;
      }
      const { provider, impl } = this.resolve(attempt.provider);
      for (const cred of creds) {
        let emitted = false;
        try {
          log.debug(
            {
              sessionId: req.sessionId,
              event: 'llm.stream.attempt',
              provider: attempt.provider,
              modelId: attempt.modelId,
              params: attempt.params
            },
            'llm stream attempt'
          );
          for await (const chunk of impl.stream(this.call(req, attempt, provider, cred))) {
            emitted = true;
            log.debug({ sessionId: req.sessionId, event: 'llm.stream.chunk', chunk }, 'llm stream chunk');
            // Stamp the resolved provider+model onto the usage so cost/ledger attribution lands on
            // the model the fallback chain actually used.
            if (chunk.type === 'usage') {
              yield {
                type: 'usage',
                usage: withResolvedModel(chunk.usage, attempt.provider, attempt.modelId) ?? chunk.usage
              };
            } else {
              yield chunk;
            }
          }
          this.deps.reportCredential?.(attempt.provider, cred.id, true);
          log.debug(
            {
              sessionId: req.sessionId,
              event: 'llm.stream.complete',
              provider: attempt.provider,
              modelId: attempt.modelId
            },
            'llm stream complete'
          );
          return;
        } catch (err) {
          this.deps.reportCredential?.(attempt.provider, cred.id, false, errInfo(err));
          log.debug(
            {
              sessionId: req.sessionId,
              event: 'llm.stream.error',
              provider: attempt.provider,
              modelId: attempt.modelId,
              err: errInfo(err)
            },
            'llm stream error'
          );
          // Once any token has streamed we're committed — a partial turn can't be cleanly
          // retried, so propagate rather than fall back.
          if (emitted) throw err;
          errors.push(err);
        }
      }
    }
    throw new AggregateError(errors, 'gateway: all model attempts failed');
  }

  async complete(req: ModelRequest): Promise<ModelResult> {
    const errors: unknown[] = [];
    log.debug(
      {
        sessionId: req.sessionId,
        event: 'llm.complete.start',
        model: req.model,
        messages: req.messages,
        tools: req.tools
      },
      'llm complete start'
    );
    for (const attempt of this.buildChain(req)) {
      const creds = this.modelCreds(attempt.provider);
      if (creds.length === 0) {
        errors.push(new Error(`no credentials configured for provider "${attempt.provider}"`));
        continue;
      }
      const { provider, impl } = this.resolve(attempt.provider);
      for (const cred of creds) {
        try {
          const call = this.call(req, attempt, provider, cred);
          const result = impl.complete ? await impl.complete(call) : await aggregate(impl.stream(call));
          this.deps.reportCredential?.(attempt.provider, cred.id, true);
          log.debug(
            {
              sessionId: req.sessionId,
              event: 'llm.complete.result',
              provider: attempt.provider,
              modelId: attempt.modelId,
              result
            },
            'llm complete result'
          );
          return { ...result, usage: withResolvedModel(result.usage, attempt.provider, attempt.modelId) };
        } catch (err) {
          this.deps.reportCredential?.(attempt.provider, cred.id, false, errInfo(err));
          log.debug(
            {
              sessionId: req.sessionId,
              event: 'llm.complete.error',
              provider: attempt.provider,
              modelId: attempt.modelId,
              err: errInfo(err)
            },
            'llm complete error'
          );
          errors.push(err);
        }
      }
    }
    throw new AggregateError(errors, 'gateway: all model attempts failed');
  }

  async generateImage(req: ImageRequest): Promise<ImageResult> {
    const errors: unknown[] = [];
    for (const attempt of this.buildChain({ model: req.model, messages: [] })) {
      const creds = this.modelCreds(attempt.provider);
      if (creds.length === 0) {
        errors.push(new Error(`no credentials configured for provider "${attempt.provider}"`));
        continue;
      }
      const { provider, impl } = this.resolve(attempt.provider);
      if (!impl.generateImage) {
        errors.push(new Error(`provider "${attempt.provider}" does not support image generation`));
        continue;
      }
      for (const cred of creds) {
        try {
          const call: ImageCall = {
            modelId: attempt.modelId,
            prompt: req.prompt,
            ...(req.size ? { size: req.size } : {}),
            ...(req.n ? { n: req.n } : {}),
            provider,
            credential: cred,
            fetch: this.deps.fetch
          };
          const result = await impl.generateImage(call);
          this.deps.reportCredential?.(attempt.provider, cred.id, true);
          return result;
        } catch (err) {
          this.deps.reportCredential?.(attempt.provider, cred.id, false, errInfo(err));
          errors.push(err);
        }
      }
    }
    throw new AggregateError(errors, 'gateway: image generation failed');
  }

  async generateSpeech(req: SpeechRequest): Promise<SpeechResult> {
    const errors: unknown[] = [];
    for (const attempt of this.buildChain({ model: req.model, messages: [] })) {
      const creds = this.modelCreds(attempt.provider);
      if (creds.length === 0) {
        errors.push(new Error(`no credentials configured for provider "${attempt.provider}"`));
        continue;
      }
      const { provider, impl } = this.resolve(attempt.provider);
      if (!impl.generateSpeech) {
        errors.push(new Error(`provider "${attempt.provider}" does not support text-to-speech`));
        continue;
      }
      for (const cred of creds) {
        try {
          const call: SpeechCall = {
            modelId: attempt.modelId,
            text: req.text,
            ...(req.voice ? { voice: req.voice } : {}),
            provider,
            credential: cred,
            fetch: this.deps.fetch
          };
          const result = await impl.generateSpeech(call);
          this.deps.reportCredential?.(attempt.provider, cred.id, true);
          return result;
        } catch (err) {
          this.deps.reportCredential?.(attempt.provider, cred.id, false, errInfo(err));
          errors.push(err);
        }
      }
    }
    throw new AggregateError(errors, 'gateway: speech generation failed');
  }

  async countTokens(req: ModelRequest): Promise<number | undefined> {
    for (const attempt of this.buildChain(req)) {
      const provider = this.deps.providers.find((u) => u.id === attempt.provider);
      if (!provider) continue;
      const impl = this.registry.get(provider.type);
      if (!impl?.countTokens) continue;
      const [cred] = this.modelCreds(attempt.provider);
      if (!cred) continue;
      const count = await impl.countTokens(this.call(req, attempt, provider, cred));
      if (count !== undefined) return count;
    }
    return undefined;
  }

  /** Query current quota / credit balance for a named provider id. Delegates to the provider
   *  atom's `getUsageLimits` if implemented. Best-effort — returns undefined when the provider
   *  has no such endpoint or the call fails.
   *
   *  Credential selection: admin key (`authType === 'admin_api_key'`) takes precedence so
   *  providers like Anthropic can reach their Admin API; falls back to the first regular
   *  credential for providers like OpenRouter that use a standard key. */
  async getUsageLimits(providerId: string): Promise<UsageLimits | undefined> {
    const provider = this.deps.providers.find((p) => p.id === providerId);
    if (!provider) return undefined;
    const impl = this.registry.get(provider.type);
    if (!impl?.getUsageLimits) return undefined;
    const all = this.deps.credentialsFor(providerId);
    const cred = all.find((c) => c.authType === 'admin_api_key') ?? all.find((c) => c.authType !== 'admin_api_key');
    if (!cred) return undefined;
    return impl.getUsageLimits(provider, cred);
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    const spec = this.deps.embeddingModel;
    if (!spec) throw new Error('gateway: no embedding model configured (set the embedding model role)');
    if (texts.length === 0) return { embeddings: [] };
    const errors: unknown[] = [];
    for (const attempt of this.buildChain({ model: spec, messages: [] })) {
      const { provider, impl } = this.resolve(attempt.provider);
      if (!impl.embed) {
        errors.push(new Error(`provider "${attempt.provider}" does not support embeddings`));
        continue;
      }
      for (const cred of this.modelCreds(attempt.provider)) {
        try {
          const result = await impl.embed({
            modelId: attempt.modelId,
            texts,
            provider,
            credential: cred,
            fetch: this.deps.fetch
          });
          this.deps.reportCredential?.(attempt.provider, cred.id, true);
          // Stamp the resolved provider+model onto usage so the indexer books the embedding cost
          // against the model that actually served it (mirrors stream/complete attribution).
          return {
            embeddings: result.embeddings,
            usage: withResolvedModel(result.usage, attempt.provider, attempt.modelId) ?? result.usage
          };
        } catch (err) {
          this.deps.reportCredential?.(attempt.provider, cred.id, false, errInfo(err));
          errors.push(err);
        }
      }
    }
    throw new AggregateError(errors, `gateway: embedding failed for "${spec}"`);
  }

  // ── resolution helpers ──────────────────────────────────────────────────────

  private resolve(providerId: string): { provider: ResolvedProviderConfig; impl: ModelProvider } {
    const provider = this.deps.providers.find((u) => u.id === providerId);
    if (!provider) throw new Error(`gateway: unknown provider "${providerId}"`);
    const impl = this.registry.get(provider.type);
    if (!impl) throw new Error(`gateway: no provider registered for provider type "${provider.type}"`);
    return { provider, impl };
  }

  private call(
    req: ModelRequest,
    attempt: Attempt,
    provider: ResolvedProviderConfig,
    cred: ProviderCredential
  ): ModelCall {
    return {
      modelId: attempt.modelId,
      messages: req.messages,
      ...(req.tools ? { tools: req.tools } : {}),
      ...(this.deps.searchToolProvider ? { searchToolProvider: this.deps.searchToolProvider } : {}),
      params: attempt.params,
      provider,
      credential: cred,
      fetch: this.deps.fetch,
      ...(req.sessionId ? { sessionId: req.sessionId } : {}),
      ...(req.userId ? { userId: req.userId } : {}),
      ...(req.maxThinkingTokens ? { maxThinkingTokens: req.maxThinkingTokens } : {})
    };
  }

  private buildChain(req: ModelRequest): Attempt[] {
    const spec = req.model || this.deps.defaultProfile;
    if (!spec) throw new Error('gateway: no model specified and no default profile configured');

    // Raw "providerId:modelId" spec — bypasses profiles, no fallbacks.
    const rawSep = spec.indexOf(':');
    if (rawSep > 0) {
      const provider = spec.slice(0, rawSep);
      const modelId = spec.slice(rawSep + 1);
      const routeParams = this.paramsForRoute(provider, modelId);
      return [{ provider, modelId, params: mergeParams(routeParams ?? {}, req.params) }];
    }

    const chain: Attempt[] = [];
    this.expandProfile(spec, req.params, new Set(), chain, true);
    return chain;
  }

  private expandProfile(
    alias: string,
    overrideParams: GenerationParams | undefined,
    visited: Set<string>,
    out: Attempt[],
    isPrimary: boolean
  ): void {
    if (visited.has(alias)) return; // guard against fallback cycles
    visited.add(alias);

    const profile = this.deps.profiles.find((p) => p.alias === alias);
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
      if ('profile' in fb) this.expandProfile(fb.profile, undefined, visited, out, false);
      else out.push({ provider: fb.provider, modelId: fb.modelId, params: {} });
    }
  }

  private paramsForRoute(provider: string, modelId: string): GenerationParams | undefined {
    for (const profile of this.deps.profiles) {
      for (const role of Object.keys(profile.routes) as ModelRole[]) {
        if (role === 'chat') continue;
        const route = profile.routes[role];
        if (route?.provider === provider && route.modelId === modelId) return profile.routeParams?.[role];
      }
    }
    return undefined;
  }
}

/** Aggregate a stream into a ModelResult — used when a provider implements `stream` but not the
 *  optional `complete`. */
async function aggregate(stream: AsyncIterable<ModelChunk>): Promise<ModelResult> {
  let text = '';
  const toolCalls: NonNullable<ModelResult['toolCalls']> = [];
  let usage: ModelResult['usage'];
  let finishReason: string | undefined;
  for await (const chunk of stream) {
    if (chunk.type === 'text') text += chunk.token;
    else if (chunk.type === 'tool-call') toolCalls.push(chunk.call);
    else if (chunk.type === 'finish') finishReason = chunk.reason;
    else if (chunk.type === 'usage') usage = chunk.usage;
  }
  return {
    text,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(usage ? { usage } : {}),
    // Prefer the provider's reported reason; fall back to inferring from tool-call presence.
    finishReason: finishReason ?? (toolCalls.length ? 'tool-calls' : 'stop')
  };
}

// A successful authenticated list proves the credential works without spending any generation
// tokens — the preferred connection test. Delegates to the provider's own listModels; providers
// without one fall back to the generic OpenAI-style /models route using their descriptor base URL.
export async function fetchProviderModels(
  provider: ResolvedProviderConfig,
  cred: ProviderCredential,
  registry: ModelProviderRegistry,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): Promise<ModelInfo[]> {
  const impl = registry.get(provider.type);
  if (impl?.listModels) return impl.listModels(provider, cred, fetchImpl);

  const base = (cred.baseUrl ?? provider.baseUrl ?? impl?.descriptor.defaultBaseUrl)?.replace(/\/$/, '');
  if (!base) throw new Error(`cannot list models: provider "${provider.id}" (${provider.type}) has no base url`);
  const res = await fetchImpl(`${base}/models`, { headers: { authorization: `Bearer ${cred.accessToken}` } });
  if (!res.ok) throw new Error(await modelsHttpError(res));
  const json = (await res.json()) as {
    data?: Array<{ id: string; name?: string; pricing?: Parameters<typeof openAiPrice>[0] }>;
  };
  return (json.data ?? []).map((m) => {
    const price = openAiPrice(m.pricing);
    return price ? { id: m.id, label: m.name, price } : { id: m.id, label: m.name };
  });
}

export async function listProviderModels(
  provider: ResolvedProviderConfig,
  cred: ProviderCredential,
  registry: ModelProviderRegistry,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): Promise<ModelInfo[]> {
  try {
    return await fetchProviderModels(provider, cred, registry, fetchImpl);
  } catch {
    return [];
  }
}

async function modelsHttpError(res: Response): Promise<string> {
  let body = '';
  try {
    body = (await res.text()).slice(0, 200);
  } catch {
    // ignore — the status alone is enough
  }
  return `models request failed: ${res.status}${body ? ` — ${body}` : ''}`;
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

function errInfo(err: unknown): { code?: string; message?: string } {
  const e = err as { statusCode?: number; code?: string; message?: string } | undefined;
  return {
    code: e?.code ?? (e?.statusCode !== undefined ? String(e.statusCode) : undefined),
    message: e?.message
  };
}
