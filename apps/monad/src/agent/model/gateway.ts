// Intentionally free of any @monad/home dependency: the daemon reads config.json/auth.json and
// injects already-resolved settings plus a `credentialsFor` accessor, so agent-core never touches
// the filesystem. Also free of ai-sdk: the gateway resolves a profile → provider + credential and
// drives the provider through the ai-sdk-free ModelProvider contract; ai-sdk lives in @monad/atoms.

import type { ModelChunk, ProviderCredential, ResolvedProviderConfig, UsageLimits } from '@monad/sdk-atom';
import type { ResolvedProfile } from './gateway-routing.ts';
import type {
  EmbedResult,
  ImageRequest,
  ImageResult,
  ModelRequest,
  ModelResult,
  ModelRouter,
  RerankRequest,
  RerankResult,
  SpeechRequest,
  SpeechResult,
  TranscriptionRequest,
  TranscriptionResult,
  VideoRequest,
  VideoResult
} from './index.ts';

import { createLogger } from '@monad/logger';

import {
  generateImage as generateImageAttempt,
  generateSpeech as generateSpeechAttempt,
  generateVideo as generateVideoAttempt,
  rerank as rerankAttempt,
  transcribe as transcribeAttempt
} from './gateway-media.ts';
import { buildCall, buildChain, errInfo, modelCreds, resolveProvider } from './gateway-routing.ts';
import { withResolvedModel } from './index.ts';
import { ModelProviderRegistry } from './provider.ts';

export type { ProviderCredential, ResolvedProviderConfig } from '@monad/sdk-atom';

export { fetchProviderModels, listProviderModels } from './gateway-models.ts';

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

const log = createLogger('model:gateway');

export class GatewayModelRouter implements ModelRouter {
  constructor(
    private readonly deps: GatewayDeps,
    private readonly registry: ModelProviderRegistry
  ) {}

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
    for (const attempt of buildChain(this.deps, req)) {
      const creds = modelCreds(this.deps, attempt.provider);
      if (creds.length === 0) {
        errors.push(new Error(`no credentials configured for provider "${attempt.provider}"`));
        continue;
      }
      const { provider, impl } = resolveProvider(this.deps, this.registry, attempt.provider);
      if (!impl.stream) {
        errors.push(new Error(`provider "${attempt.provider}" does not support text generation`));
        continue;
      }
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
          for await (const chunk of impl.stream(buildCall(this.deps, req, attempt, provider, cred))) {
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
    throw new AggregateError(errors, textGenerationErrorMessage(errors));
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
    for (const attempt of buildChain(this.deps, req)) {
      const creds = modelCreds(this.deps, attempt.provider);
      if (creds.length === 0) {
        errors.push(new Error(`no credentials configured for provider "${attempt.provider}"`));
        continue;
      }
      const { provider, impl } = resolveProvider(this.deps, this.registry, attempt.provider);
      const complete = impl.complete;
      const stream = impl.stream;
      if (!complete && !stream) {
        errors.push(new Error(`provider "${attempt.provider}" does not support text generation`));
        continue;
      }
      for (const cred of creds) {
        try {
          const call = buildCall(this.deps, req, attempt, provider, cred);
          let result: ModelResult;
          if (complete) {
            result = await complete(call);
          } else if (stream) {
            result = await aggregate(stream(call));
          } else {
            throw new Error(`provider "${attempt.provider}" does not support text generation`);
          }
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
    throw new AggregateError(errors, textGenerationErrorMessage(errors));
  }

  async generateImage(req: ImageRequest): Promise<ImageResult> {
    return generateImageAttempt(this.deps, this.registry, req);
  }

  async generateSpeech(req: SpeechRequest): Promise<SpeechResult> {
    return generateSpeechAttempt(this.deps, this.registry, req);
  }

  async generateVideo(req: VideoRequest): Promise<VideoResult> {
    return generateVideoAttempt(this.deps, this.registry, req);
  }

  async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    return transcribeAttempt(this.deps, this.registry, req);
  }

  async rerank(req: RerankRequest): Promise<RerankResult> {
    return rerankAttempt(this.deps, this.registry, req);
  }

  async countTokens(req: ModelRequest): Promise<number | undefined> {
    for (const attempt of buildChain(this.deps, req)) {
      const provider = this.deps.providers.find((u) => u.id === attempt.provider);
      if (!provider) continue;
      const impl = this.registry.get(provider.type);
      if (!impl?.countTokens) continue;
      const [cred] = modelCreds(this.deps, attempt.provider);
      if (!cred) continue;
      const count = await impl.countTokens(buildCall(this.deps, req, attempt, provider, cred));
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
    for (const attempt of buildChain(this.deps, { model: spec, messages: [] })) {
      const { provider, impl } = resolveProvider(this.deps, this.registry, attempt.provider);
      if (!impl.embed) {
        errors.push(new Error(`provider "${attempt.provider}" does not support embeddings`));
        continue;
      }
      for (const cred of modelCreds(this.deps, attempt.provider)) {
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

function textGenerationErrorMessage(errors: unknown[]): string {
  return errors.some((err) => err instanceof Error && /text generation/i.test(err.message))
    ? 'gateway: text generation failed'
    : 'gateway: all model attempts failed';
}
