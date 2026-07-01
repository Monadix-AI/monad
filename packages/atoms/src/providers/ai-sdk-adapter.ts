// The ai-sdk boundary. EVERYTHING that touches the Vercel `ai` SDK lives here — message/tool
// conversion, the streamText/generateText calls, usage normalization. monad's first-party
// providers are thin wrappers that build an ai-sdk LanguageModel and delegate to these helpers;
// the @monad/sdk-atom contract they implement is ai-sdk-free, so a third-party provider can
// ignore this file entirely and implement ModelProvider against any backend.

import type {
  EmbedCall,
  EmbedResult,
  GenerationParams,
  ImageCall,
  ImageResult,
  ModelCall,
  ModelChunk,
  ModelContentPart,
  ModelInfo,
  ModelProvider,
  ModelProviderDescriptor,
  ModelResult,
  ModelUsage,
  ProviderCredential,
  RerankCall,
  RerankResult,
  ResolvedProviderConfig,
  SpeechCall,
  SpeechResult,
  ToolCall,
  ToolSpec,
  TranscriptionCall,
  TranscriptionResult,
  UsageLimits,
  VideoCall,
  VideoResult
} from '@monad/sdk-atom';
import type {
  EmbeddingModel,
  ImageModel,
  JSONValue,
  LanguageModel,
  ProviderMetadata,
  RerankingModel,
  ModelMessage as SdkMessage,
  SpeechModel,
  Telemetry,
  ToolSet,
  TranscriptionModel
} from 'ai';

import { anthropic } from '@ai-sdk/anthropic';
import { DevToolsTelemetry } from '@ai-sdk/devtools';
import { openai } from '@ai-sdk/openai';
import { OpenTelemetry } from '@ai-sdk/otel';
import { extractCacheWrite, extractProviderCost } from '@monad/sdk-atom';
import {
  embedMany,
  generateImage,
  experimental_generateSpeech as generateSpeech,
  generateText,
  experimental_generateVideo as generateVideo,
  jsonSchema,
  rerank,
  streamText,
  tool,
  experimental_transcribe as transcribe
} from 'ai';

type ProviderOpts = Record<string, Record<string, JSONValue>>;
type VideoModel = Parameters<typeof generateVideo>[0]['model'];

/** Plain-text projection of a request for a native count-tokens call. */
export interface CountTokensInput {
  system?: string;
  text: string;
  tools?: ToolSpec[];
}

/** Which HTTP response header style the provider uses for rate-limit info.
 *  'openai'     → x-ratelimit-remaining-{requests,tokens}, x-ratelimit-reset-{requests,tokens}
 *                 reset value is a duration string e.g. "6m0s" or "500ms"
 *  'anthropic'  → anthropic-ratelimit-{requests,tokens}-{remaining,reset}
 *                 reset value is an ISO 8601 datetime */
type RateLimitHeaderStyle = 'openai' | 'anthropic';

/** What each first-party provider supplies; defineAiSdkProvider wires it into the contract. */
export interface AiSdkProviderSpec {
  type: string;
  descriptor: ModelProviderDescriptor;
  /** Build the ai-sdk language model for this call (reads call.provider / call.credential). */
  build?(call: ModelCall): LanguageModel;
  reasoningOptions?(
    effort: NonNullable<GenerationParams['reasoningEffort']>,
    maxThinkingTokens?: number
  ): ProviderOpts | undefined;
  buildImageModel?(call: ImageCall): ImageModel;
  buildVideoModel?(call: VideoCall): VideoModel;
  buildSpeechModel?(call: SpeechCall): SpeechModel;
  buildTranscriptionModel?(call: TranscriptionCall): TranscriptionModel;
  buildRerankingModel?(call: RerankCall): RerankingModel;
  buildEmbeddingModel?(call: EmbedCall): EmbeddingModel;
  generateVideo?(call: VideoCall): Promise<VideoResult>;
  generateSpeech?(call: SpeechCall): Promise<SpeechResult>;
  transcribe?(call: TranscriptionCall): Promise<TranscriptionResult>;
  rerank?(call: RerankCall): Promise<RerankResult>;
  listModels?(provider: ResolvedProviderConfig, cred?: ProviderCredential): Promise<ModelInfo[]>;
  countTokens?(call: ModelCall): Promise<number | undefined>;
  getUsageLimits?(provider: ResolvedProviderConfig, cred: ProviderCredential): Promise<UsageLimits | undefined>;
  /** Which HTTP header style to capture for rate-limit info. Absent → no capture. */
  rateLimitHeaderStyle?: RateLimitHeaderStyle;
}

// The AI SDK requires system prompts via its dedicated `system` option — inline system messages
// in `messages` are flagged as a prompt-injection risk. A `cache`-marked system message is emitted
// as a leading message carrying an Anthropic cache breakpoint (other providers ignore it).
export function splitSystem(messages: ModelMessageLike[]): {
  system?: string;
  messages: SdkMessage[];
  allowSystemInMessages?: boolean;
} {
  const sysMsg = messages.find((m) => m.role === 'system');
  const sysText = typeof sysMsg?.content === 'string' ? sysMsg.content : undefined;
  const rest = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : m.content.map(toSdkPart)
    })) as SdkMessage[];

  if (sysMsg?.cache && sysText !== undefined) {
    const cachedSystem = {
      role: 'system',
      content: sysText,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } }
    } as unknown as SdkMessage;
    return { messages: [cachedSystem, ...rest], allowSystemInMessages: true };
  }
  return { system: sysText, messages: rest };
}

type ModelMessageLike = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ModelContentPart[];
  cache?: boolean;
};

function toSdkPart(p: ModelContentPart) {
  switch (p.type) {
    case 'text':
      return { type: 'text' as const, text: p.text };
    case 'image':
      return { type: 'image' as const, image: p.image, ...(p.mediaType ? { mediaType: p.mediaType } : {}) };
    case 'tool-call':
      return { type: 'tool-call' as const, toolCallId: p.toolCallId, toolName: p.toolName, input: p.input };
    case 'tool-result':
      return {
        type: 'tool-result' as const,
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        output: { type: 'text' as const, value: p.output }
      };
  }
}

function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// OpenAI-style reset header value: "6m0s", "500ms", "1s", "2h30m" etc. → epoch ms.
function parseDurationToResetMs(value: string): number | undefined {
  const now = Date.now();
  let ms = 0;
  const re = /(\d+(?:\.\d+)?)(h|m(?:s)?|s)/g;
  for (let match = re.exec(value); match !== null; match = re.exec(value)) {
    const n = parseFloat(match[1] ?? '');
    const unit = match[2];
    if (unit === 'h') ms += n * 3_600_000;
    else if (unit === 'm') ms += n * 60_000;
    else if (unit === 'ms') ms += n;
    else if (unit === 's') ms += n * 1_000;
  }
  return ms > 0 ? now + ms : undefined;
}

function extractRateLimitHeaders(headers: Headers, style: RateLimitHeaderStyle): UsageLimits | undefined {
  let requestsRemaining: number | undefined;
  let requestsLimit: number | undefined;
  let tokensRemaining: number | undefined;
  let tokensLimit: number | undefined;
  let inputTokensRemaining: number | undefined;
  let inputTokensLimit: number | undefined;
  let outputTokensRemaining: number | undefined;
  let outputTokensLimit: number | undefined;
  let resetAtMs: number | undefined;

  if (style === 'anthropic') {
    requestsRemaining = finite(Number(headers.get('anthropic-ratelimit-requests-remaining')));
    requestsLimit = finite(Number(headers.get('anthropic-ratelimit-requests-limit')));
    tokensRemaining = finite(Number(headers.get('anthropic-ratelimit-tokens-remaining')));
    tokensLimit = finite(Number(headers.get('anthropic-ratelimit-tokens-limit')));
    inputTokensRemaining = finite(Number(headers.get('anthropic-ratelimit-input-tokens-remaining')));
    inputTokensLimit = finite(Number(headers.get('anthropic-ratelimit-input-tokens-limit')));
    outputTokensRemaining = finite(Number(headers.get('anthropic-ratelimit-output-tokens-remaining')));
    outputTokensLimit = finite(Number(headers.get('anthropic-ratelimit-output-tokens-limit')));
    const resetRaw =
      headers.get('anthropic-ratelimit-tokens-reset') ??
      headers.get('anthropic-ratelimit-input-tokens-reset') ??
      headers.get('anthropic-ratelimit-requests-reset');
    if (resetRaw) {
      const t = Date.parse(resetRaw);
      if (!Number.isNaN(t)) resetAtMs = t;
    }
  } else {
    // openai style
    requestsRemaining = finite(Number(headers.get('x-ratelimit-remaining-requests')));
    requestsLimit = finite(Number(headers.get('x-ratelimit-limit-requests')));
    tokensRemaining = finite(Number(headers.get('x-ratelimit-remaining-tokens')));
    tokensLimit = finite(Number(headers.get('x-ratelimit-limit-tokens')));
    const resetRaw = headers.get('x-ratelimit-reset-tokens') ?? headers.get('x-ratelimit-reset-requests');
    if (resetRaw) resetAtMs = parseDurationToResetMs(resetRaw);
  }

  const out: UsageLimits = {
    requestsRemaining,
    requestsLimit,
    tokensRemaining,
    tokensLimit,
    inputTokensRemaining,
    inputTokensLimit,
    outputTokensRemaining,
    outputTokensLimit,
    resetAtMs
  };
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}

/** Wraps a fetch implementation to capture rate-limit response headers.
 *  The captured value is written into `sink.current` on the first successful response.
 *  `maxRetries: 0` in ai-sdk calls ensures at most one HTTP round-trip per invocation. */
function wrapFetchForRateLimits(
  baseFetch: typeof globalThis.fetch,
  style: RateLimitHeaderStyle,
  sink: { current: UsageLimits | undefined }
): typeof globalThis.fetch {
  const wrapper = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init: Parameters<typeof globalThis.fetch>[1]
  ) => {
    const response = await baseFetch(input, init);
    const info = extractRateLimitHeaders(response.headers, style);
    if (info) sink.current = info;
    return response;
  };
  // Copy all extra properties (e.g. Bun's `preconnect`) so the wrapper is structurally identical.
  return Object.assign(wrapper, baseFetch);
}

export function toUsage(
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        cachedInputTokens?: number;
        reasoningTokens?: number;
      }
    | undefined,
  providerMetadata?: ProviderMetadata,
  rateLimitInfo?: UsageLimits
): ModelUsage | undefined {
  if (!usage) return undefined;
  const inputTokens = finite(usage.inputTokens);
  const outputTokens = finite(usage.outputTokens);
  const totalTokens =
    finite(usage.totalTokens) ??
    (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
  const out: ModelUsage = {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens: finite(usage.cachedInputTokens),
    cacheWriteTokens: extractCacheWrite(providerMetadata),
    reasoningTokens: finite(usage.reasoningTokens),
    costUsd: extractProviderCost(providerMetadata),
    ...(rateLimitInfo ? { rateLimitInfo } : {})
  };
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}

function allowsProviderNativeSearch(provider: ModelCall['searchToolProvider']): boolean {
  return provider === undefined || provider === 'auto' || provider === 'native';
}

/** Build the AI SDK tool set for native function-calling. No `execute`: the model returns
 *  tool-calls and stops; the loop owns execution (approval gate, persistence, events).
 *  Provider-native hints (computer-use, web_search) emit the provider's built-in tool spec
 *  instead of a generic function tool; server-side tools (web_search, webSearchPreview) are
 *  executed by the provider — the loop persists their steps but skips local execution. */
export function buildSdkTools(
  tools: ToolSpec[] | undefined,
  providerType: string,
  searchToolProvider?: ModelCall['searchToolProvider']
): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined;
  const set: ToolSet = {};
  for (const t of tools) {
    const anthropicHint = providerType === 'anthropic' ? t.providerTool?.anthropic : undefined;
    if (anthropicHint) {
      if (
        allowsProviderNativeSearch(searchToolProvider) &&
        (anthropicHint.type === 'web_search_20250305' || anthropicHint.type === 'web_search_20260209')
      ) {
        const opts = {
          ...(anthropicHint.maxUses !== undefined ? { maxUses: anthropicHint.maxUses } : {}),
          ...(anthropicHint.allowedDomains ? { allowedDomains: anthropicHint.allowedDomains } : {}),
          ...(anthropicHint.blockedDomains ? { blockedDomains: anthropicHint.blockedDomains } : {})
        };
        set[t.name] =
          anthropicHint.type === 'web_search_20260209'
            ? anthropic.tools.webSearch_20260209(opts)
            : anthropic.tools.webSearch_20250305(opts);
        continue;
      }
      // computer-use: client-executed tool with display dimensions (narrowed via discriminant)
      if (anthropicHint.type === 'computer_20250124' || anthropicHint.type === 'computer_20251124') {
        const opts = {
          displayWidthPx: anthropicHint.displayWidthPx,
          displayHeightPx: anthropicHint.displayHeightPx,
          ...(anthropicHint.displayNumber !== undefined ? { displayNumber: anthropicHint.displayNumber } : {})
        };
        set[t.name] =
          anthropicHint.type === 'computer_20251124'
            ? anthropic.tools.computer_20251124({ ...opts, ...(anthropicHint.enableZoom ? { enableZoom: true } : {}) })
            : anthropic.tools.computer_20250124(opts);
        continue;
      }
    }
    const openaiHint = providerType === 'openai' ? t.providerTool?.openai : undefined;
    if (allowsProviderNativeSearch(searchToolProvider) && openaiHint?.type === 'web_search_preview') {
      set[t.name] = openai.tools.webSearchPreview(
        openaiHint.searchContextSize ? { searchContextSize: openaiHint.searchContextSize } : {}
      );
      continue;
    }
    set[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.parameters ?? { type: 'object', properties: {} })
    });
  }
  return set;
}

/** True when the tool spec declares a provider-executed (server-side) binding for providerType.
 *  Used to flag tool calls returned from generateText so runToolLoop skips local execution. */
function isProviderNativeTool(
  spec: ToolSpec,
  providerType: string,
  searchToolProvider?: ModelCall['searchToolProvider']
): boolean {
  if (!allowsProviderNativeSearch(searchToolProvider)) return false;
  if (providerType === 'anthropic') {
    const h = spec.providerTool?.anthropic;
    return h?.type === 'web_search_20250305' || h?.type === 'web_search_20260209';
  }
  if (providerType === 'openai') {
    return spec.providerTool?.openai?.type === 'web_search_preview';
  }
  return false;
}

function toModelToolCalls(
  calls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }> | undefined,
  toolSpecs: ToolSpec[] | undefined,
  providerType: string,
  searchToolProvider?: ModelCall['searchToolProvider']
): ToolCall[] | undefined {
  if (!calls || calls.length === 0) return undefined;
  return calls.map((c) => {
    const spec = toolSpecs?.find((s) => s.name === c.toolName);
    const providerExecuted = spec ? isProviderNativeTool(spec, providerType, searchToolProvider) : false;
    return {
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      input: c.input,
      ...(providerExecuted ? { providerExecuted: true } : {})
    };
  });
}

/** Project a neutral message list to {system, text, tools} for a native count-tokens call. */
export function renderForCount(call: ModelCall): CountTokensInput {
  let system: string | undefined;
  const parts: string[] = [];
  for (const m of call.messages) {
    const text = renderCountContent(m.content);
    if (m.role === 'system') system = system === undefined ? text : `${system}\n${text}`;
    else if (text) parts.push(text);
  }
  return { system, text: parts.join('\n'), ...(call.tools ? { tools: call.tools } : {}) };
}

function renderCountContent(content: string | ModelContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((p) => {
      switch (p.type) {
        case 'text':
          return p.text;
        case 'tool-call':
          return typeof p.input === 'string' ? p.input : JSON.stringify(p.input);
        case 'tool-result':
          return p.output;
        case 'image':
          return '';
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n');
}

function callSettings(
  params: GenerationParams,
  reasoningOptions?: AiSdkProviderSpec['reasoningOptions'],
  maxThinkingTokens?: number
): { temperature?: number; maxOutputTokens?: number; topP?: number; providerOptions?: ProviderOpts } {
  const settings: { temperature?: number; maxOutputTokens?: number; topP?: number; providerOptions?: ProviderOpts } =
    {};
  if (params.temperature !== undefined) settings.temperature = params.temperature;
  if (params.maxTokens !== undefined) settings.maxOutputTokens = params.maxTokens;
  if (params.topP !== undefined) settings.topP = params.topP;
  if (params.reasoningEffort && reasoningOptions) {
    const opts = reasoningOptions(params.reasoningEffort, maxThinkingTokens);
    if (opts) settings.providerOptions = opts;
  }
  return settings;
}

const otelTelemetry = new OpenTelemetry({
  usage: true,
  providerMetadata: true,
  runtimeContext: true,
  enrichSpan({ runtimeContext }) {
    return {
      ...(typeof runtimeContext?.sessionId === 'string'
        ? { 'ai.telemetry.metadata.sessionId': runtimeContext.sessionId }
        : {}),
      ...(typeof runtimeContext?.userId === 'string' ? { 'ai.telemetry.metadata.userId': runtimeContext.userId } : {})
    };
  }
});

function telemetryIntegrations(): Telemetry[] {
  return Bun.env.NODE_ENV === 'development' ? [otelTelemetry, DevToolsTelemetry()] : [otelTelemetry];
}

type AiSdkRuntimeContext = {
  provider: string;
  model: string;
  sessionId?: string;
  userId?: string;
};

// Shared `telemetry` config for both the stream and complete paths — keeps the two
// call sites from drifting (a field added to one but not the other). Phoenix reads runtime context;
// sessionId/userId are promoted to OpenInference session.id/user.id by the daemon span processor.
function buildTelemetry(
  call: ModelCall,
  spec: AiSdkProviderSpec,
  functionId: string
): {
  runtimeContext: AiSdkRuntimeContext;
  telemetry: {
    isEnabled: true;
    recordInputs: true;
    recordOutputs: true;
    functionId: string;
    includeRuntimeContext: Record<keyof AiSdkRuntimeContext, true>;
    integrations: Telemetry[];
  };
} {
  const runtimeContext: AiSdkRuntimeContext = {
    provider: spec.type,
    model: call.modelId,
    ...(call.sessionId ? { sessionId: call.sessionId } : {}),
    ...(call.userId ? { userId: call.userId } : {})
  };
  const telemetry: {
    isEnabled: true;
    recordInputs: true;
    recordOutputs: true;
    functionId: string;
    includeRuntimeContext: Record<keyof AiSdkRuntimeContext, true>;
    integrations: Telemetry[];
  } = {
    isEnabled: true,
    recordInputs: true,
    recordOutputs: true,
    functionId,
    includeRuntimeContext: {
      provider: true,
      model: true,
      sessionId: true,
      userId: true
    },
    integrations: telemetryIntegrations()
  };
  return { runtimeContext, telemetry };
}

function buildLanguageModel(spec: AiSdkProviderSpec, call: ModelCall): LanguageModel {
  if (!spec.build) throw new Error(`provider "${spec.type}" does not support text generation`);
  return spec.build(call);
}

async function* streamViaAiSdk(call: ModelCall, spec: AiSdkProviderSpec): AsyncIterable<ModelChunk> {
  const { system, messages, allowSystemInMessages } = splitSystem(call.messages);
  const tools = buildSdkTools(call.tools, spec.type, call.searchToolProvider);
  const rateLimitSink: { current: UsageLimits | undefined } = { current: undefined };
  const callFetch = spec.rateLimitHeaderStyle
    ? wrapFetchForRateLimits(call.fetch ?? globalThis.fetch, spec.rateLimitHeaderStyle, rateLimitSink)
    : call.fetch;
  const telemetryConfig = buildTelemetry(call, spec, 'monad.stream');
  const result = streamText({
    model: buildLanguageModel(spec, { ...call, fetch: callFetch }),
    system,
    messages,
    ...(tools ? { tools } : {}),
    ...(allowSystemInMessages ? { allowSystemInMessages: true } : {}),
    // monad does its own cross-credential / cross-model fallback (in the gateway), so disable
    // the SDK's per-call retry — otherwise a 429 stalls on its backoff here.
    maxRetries: 0,
    ...(call.signal ? { abortSignal: call.signal } : {}),
    ...callSettings(call.params, spec.reasoningOptions, call.maxThinkingTokens),
    runtimeContext: telemetryConfig.runtimeContext,
    telemetry: telemetryConfig.telemetry
  });
  // Consume fullStream (not textStream): request failures surface as `error` parts rather than
  // thrown exceptions, and the gateway must see them (as a throw) to fail over.
  try {
    for await (const part of result.fullStream) {
      if (part.type === 'error') throw part.error;
      if (part.type === 'text-delta' && part.text) yield { type: 'text', token: part.text };
      else if (part.type === 'reasoning-delta' && part.text) yield { type: 'reasoning', token: part.text };
      else if (part.type === 'tool-call') {
        yield {
          type: 'tool-call',
          call: {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            ...(part.providerExecuted ? { providerExecuted: true } : {})
          }
        };
      } else if (part.type === 'tool-result' && part.providerExecuted) {
        // Provider-executed tool (e.g. Anthropic web_search): result already resolved by provider.
        yield {
          type: 'tool-result',
          callId: part.toolCallId,
          toolName: part.toolName,
          output: typeof part.output === 'string' ? part.output : JSON.stringify(part.output)
        };
      } else if (part.type === 'finish') {
        yield { type: 'finish', reason: part.finishReason };
      }
    }
  } catch (err) {
    // StreamTextResult creates four DelayedPromise fields (_totalUsage, _finishReason,
    // _rawFinishReason, _steps) that get rejected when the stream fails. If the caller
    // throws before awaiting them (gateway retry on 429), they become unhandled rejections
    // that Bun's native reporter prints. Silence all four here.
    // biome-ignore lint/suspicious/noExplicitAny: accessing private DelayedPromise fields not exposed in the type
    const r = result as any;
    void r._totalUsage?.promise?.catch(() => {});
    void r._finishReason?.promise?.catch(() => {});
    void r._rawFinishReason?.promise?.catch(() => {});
    void r._steps?.promise?.catch(() => {});
    throw err;
  }
  const usage = toUsage(await result.totalUsage, await result.providerMetadata, rateLimitSink.current);
  if (usage) yield { type: 'usage', usage };
}

async function completeViaAiSdk(call: ModelCall, spec: AiSdkProviderSpec): Promise<ModelResult> {
  const { system, messages, allowSystemInMessages } = splitSystem(call.messages);
  const tools = buildSdkTools(call.tools, spec.type, call.searchToolProvider);
  const rateLimitSink: { current: UsageLimits | undefined } = { current: undefined };
  const callFetch = spec.rateLimitHeaderStyle
    ? wrapFetchForRateLimits(call.fetch ?? globalThis.fetch, spec.rateLimitHeaderStyle, rateLimitSink)
    : call.fetch;
  const telemetryConfig = buildTelemetry(call, spec, 'monad.complete');
  const { text, toolCalls, usage, finishReason, providerMetadata } = await generateText({
    model: buildLanguageModel(spec, { ...call, fetch: callFetch }),
    system,
    messages,
    ...(tools ? { tools } : {}),
    ...(allowSystemInMessages ? { allowSystemInMessages: true } : {}),
    maxRetries: 0,
    ...(call.signal ? { abortSignal: call.signal } : {}),
    ...callSettings(call.params, spec.reasoningOptions, call.maxThinkingTokens),
    runtimeContext: telemetryConfig.runtimeContext,
    telemetry: telemetryConfig.telemetry
  });
  return {
    text,
    toolCalls: toModelToolCalls(toolCalls, call.tools, spec.type, call.searchToolProvider),
    usage: toUsage(usage, providerMetadata, rateLimitSink.current),
    finishReason
  };
}

async function imageViaAiSdk(call: ImageCall, model: ImageModel): Promise<ImageResult> {
  const { image } = await generateImage({
    model,
    prompt: call.prompt,
    ...(call.size ? { size: call.size as `${number}x${number}` } : {}),
    ...(call.n ? { n: call.n } : {}),
    ...(call.signal ? { abortSignal: call.signal } : {})
  });
  return { image: image.uint8Array, mediaType: image.mediaType ?? 'image/png' };
}

async function videoViaAiSdk(call: VideoCall, model: VideoModel): Promise<VideoResult> {
  const image = call.image instanceof URL ? call.image.toString() : call.image;
  const prompt = image === undefined ? call.prompt : { image, ...(call.prompt ? { text: call.prompt } : {}) };
  const { video } = await generateVideo({
    model,
    prompt,
    ...(call.n ? { n: call.n } : {}),
    ...(call.aspectRatio ? { aspectRatio: call.aspectRatio as `${number}:${number}` } : {}),
    ...(call.resolution ? { resolution: call.resolution as `${number}x${number}` } : {}),
    ...(call.duration ? { duration: call.duration } : {}),
    ...(call.fps ? { fps: call.fps } : {}),
    ...(call.signal ? { abortSignal: call.signal } : {})
  });
  return { video: video.uint8Array, mediaType: video.mediaType ?? 'video/mp4' };
}

async function embedViaAiSdk(call: EmbedCall, model: EmbeddingModel): Promise<EmbedResult> {
  const { embeddings, usage } = await embedMany({
    model,
    values: call.texts,
    // monad does its own gateway-level credential fallback; disable the SDK's per-call retry.
    maxRetries: 0,
    ...(call.signal ? { abortSignal: call.signal } : {})
  });
  // embedMany reports a single `tokens` count; embeddings consume input tokens only.
  return { embeddings, usage: typeof usage?.tokens === 'number' ? { inputTokens: usage.tokens } : undefined };
}

async function speechViaAiSdk(call: SpeechCall, model: SpeechModel): Promise<SpeechResult> {
  const { audio } = await generateSpeech({
    model,
    text: call.text,
    ...(call.voice ? { voice: call.voice } : {}),
    ...(call.signal ? { abortSignal: call.signal } : {})
  });
  return { audio: audio.uint8Array, mediaType: audio.mediaType ?? 'audio/mpeg' };
}

async function transcribeViaAiSdk(call: TranscriptionCall, model: TranscriptionModel): Promise<TranscriptionResult> {
  const { text, segments, language, durationInSeconds } = await transcribe({
    model,
    audio: call.audio,
    ...(call.signal ? { abortSignal: call.signal } : {})
  });
  return {
    text,
    ...(segments.length ? { segments } : {}),
    ...(language ? { language } : {}),
    ...(durationInSeconds !== undefined ? { durationInSeconds } : {})
  };
}

async function rerankViaAiSdk(call: RerankCall, model: RerankingModel): Promise<RerankResult> {
  const result = await rerank({
    model,
    query: call.query,
    documents: call.documents,
    ...(call.topN ? { topN: call.topN } : {}),
    ...(call.signal ? { abortSignal: call.signal } : {})
  });
  return {
    ranking: result.ranking.map((ranked) => ({
      index: ranked.originalIndex,
      score: ranked.score,
      document: ranked.document
    }))
  };
}

/** Wire an ai-sdk-backed spec into the ai-sdk-free ModelProvider contract. */
export function defineAiSdkProvider(spec: AiSdkProviderSpec): ModelProvider {
  return {
    type: spec.type,
    descriptor: spec.descriptor,
    ...(spec.build
      ? {
          stream: (call: ModelCall) => streamViaAiSdk(call, spec),
          complete: (call: ModelCall) => completeViaAiSdk(call, spec)
        }
      : {}),
    ...(spec.buildImageModel
      ? {
          generateImage: (
            (buildImageModel) => (call: ImageCall) =>
              imageViaAiSdk(call, buildImageModel(call))
          )(spec.buildImageModel)
        }
      : {}),
    ...(spec.generateVideo
      ? { generateVideo: spec.generateVideo }
      : spec.buildVideoModel
        ? {
            generateVideo: (
              (buildVideoModel) => (call: VideoCall) =>
                videoViaAiSdk(call, buildVideoModel(call))
            )(spec.buildVideoModel)
          }
        : {}),
    ...(spec.generateSpeech
      ? { generateSpeech: spec.generateSpeech }
      : spec.buildSpeechModel
        ? {
            generateSpeech: (
              (buildSpeechModel) => (call: SpeechCall) =>
                speechViaAiSdk(call, buildSpeechModel(call))
            )(spec.buildSpeechModel)
          }
        : {}),
    ...(spec.transcribe
      ? { transcribe: spec.transcribe }
      : spec.buildTranscriptionModel
        ? {
            transcribe: (
              (buildTranscriptionModel) => (call: TranscriptionCall) =>
                transcribeViaAiSdk(call, buildTranscriptionModel(call))
            )(spec.buildTranscriptionModel)
          }
        : {}),
    ...(spec.rerank
      ? { rerank: spec.rerank }
      : spec.buildRerankingModel
        ? {
            rerank: (
              (buildRerankingModel) => (call: RerankCall) =>
                rerankViaAiSdk(call, buildRerankingModel(call))
            )(spec.buildRerankingModel)
          }
        : {}),
    ...(spec.buildEmbeddingModel
      ? {
          embed: (
            (buildEmbeddingModel) => (call: EmbedCall) =>
              embedViaAiSdk(call, buildEmbeddingModel(call))
          )(spec.buildEmbeddingModel)
        }
      : {}),
    ...(spec.listModels ? { listModels: spec.listModels } : {}),
    ...(spec.countTokens ? { countTokens: spec.countTokens } : {}),
    ...(spec.getUsageLimits ? { getUsageLimits: spec.getUsageLimits } : {})
  };
}
