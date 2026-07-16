// The model-provider contract — monad-native and free of any ai-sdk types. ai-sdk is only an
// implementation detail of monad's first-party providers (in @monad/atoms); a third-party
// provider may implement this against raw HTTP or any other SDK. The daemon's gateway resolves a
// profile → provider + credential and drives the provider through `stream`/`complete`; the agent
// loop only ever sees the monad-native ModelChunk/ModelResult.

import type { GenerationParams, ModelInfo, ModelProviderDescriptor, TokenUsage } from '@monad/protocol';

export type {
  GenerationParams,
  ModelInfo,
  ModelKind,
  ModelModalities,
  ModelPrice,
  ModelProviderDescriptor
} from '@monad/protocol';

export type ModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string | URL | Uint8Array; mediaType?: string }
  // Native function-calling round-trip. A tool-call rides on an assistant message; a
  // tool-result on a `tool` message (output is the text fed back to the model).
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; output: string };

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** String for plain text (the common case) or content parts for multimodal/tool input. */
  content: string | ModelContentPart[];
  /** Request a provider-agnostic prompt-cache breakpoint at this message (e.g. Anthropic
   *  ephemeral cache); providers that don't support it ignore the hint. */
  cache?: boolean;
}

/** Optional binding of a tool to a provider's BUILT-IN ("provider-defined") tool. When the active
 *  provider matches, the adapter emits the provider's native tool — its model was trained on that
 *  exact schema and the provider sets any required beta header — instead of a generic function
 *  tool; providers that don't match fall back to the generic `parameters` schema. Additive and
 *  per-provider, so one tool definition stays portable across model families.
 *  `anthropic`: computer-use (action-based schema, display dimensions) or native web/fetch search.
 *  `openai`: native web_search_preview (provider-executed, no client key required). */
export interface ProviderToolHint {
  anthropic?:
    | {
        type: 'computer_20250124' | 'computer_20251124';
        displayWidthPx: number;
        displayHeightPx: number;
        displayNumber?: number;
        /** computer_20251124 only: allow the `zoom` action for detailed region inspection. */
        enableZoom?: boolean;
      }
    | {
        /** Anthropic-executed server-side web search. No client execution; provider returns results. */
        type: 'web_search_20250305' | 'web_search_20260209';
        maxUses?: number;
        allowedDomains?: string[];
        blockedDomains?: string[];
      };
  /** OpenAI-executed web search preview. Provider runs the search; no client API key needed. */
  openai?: {
    type: 'web_search_preview';
    searchContextSize?: 'low' | 'medium' | 'high';
  };
}

/** A tool exposed to the model for native function-calling. `parameters` is JSON Schema. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  /** Optional provider-native tool binding (see ProviderToolHint). */
  providerTool?: ProviderToolHint;
}

/** A tool invocation the model asked for. The loop executes it and feeds back the result.
 *  `providerExecuted` is set when the provider (Anthropic/OpenAI) already ran the tool
 *  server-side — the loop persists the step for UI visibility but skips local execution. */
export interface ToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  providerExecuted?: boolean;
}

/** Token-level snapshot for a usage window (from an admin usage API). */
export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  /** Per-model breakdown when the API returns `group_by=model` granularity. */
  byModel?: Record<string, { inputTokens: number; outputTokens: number }>;
}

/** Rate-limit / quota snapshot for one provider credential window. All fields are best-effort:
 *  absent means the provider didn't report it, not that it is zero or unlimited. */
export interface UsageLimits {
  /** Combined requests remaining / limit (per-minute window). */
  requestsRemaining?: number;
  requestsLimit?: number;
  /** Combined token remaining / limit (most restrictive window — from response headers). */
  tokensRemaining?: number;
  tokensLimit?: number;
  /** Input-token remaining / limit reported separately (Anthropic splits input vs output). */
  inputTokensRemaining?: number;
  inputTokensLimit?: number;
  /** Output-token remaining / limit. */
  outputTokensRemaining?: number;
  outputTokensLimit?: number;
  /** When the current rate-limit window resets, epoch ms. */
  resetAtMs?: number;
  /** Remaining prepaid credit in USD (OpenRouter-style providers only). */
  creditUsd?: number;
  creditLimit?: number;
  /** Configured org-level input tokens per minute (from Rate Limits API, admin key). */
  configuredInputTokensPerMinute?: number;
  /** Configured org-level output tokens per minute (from Rate Limits API, admin key). */
  configuredOutputTokensPerMinute?: number;
  /** Token usage aggregated over the last ~5 hours (from Usage API, admin key). */
  usedLast5h?: UsageSnapshot;
  /** Token usage aggregated over the last ~24 hours. */
  usedLastDay?: UsageSnapshot;
  /** Token usage aggregated over the last ~7 days. */
  usedLastWeek?: UsageSnapshot;
  /** USD spend over the last ~24 hours (OpenRouter-style providers). */
  spendUsdDay?: number;
  /** USD spend over the last ~7 days. */
  spendUsdWeek?: number;
  /** USD spend over the last ~30 days. */
  spendUsdMonth?: number;
}

/** The wire `TokenUsage` (single source) plus in-process-only telemetry the agent loop carries but
 *  never serialises as part of the token-count shape. The token fields are derived, not redeclared. */
export type ModelUsage = TokenUsage & {
  /** Provider-reported REAL USD cost for the turn (e.g. OpenRouter usage accounting), when the
   *  provider returns one. In-process telemetry only — feeds the cost ledger's authoritative
   *  source rather than a catalog-price estimate. */
  costUsd?: number;
  /** The provider id + model id that ACTUALLY served this turn — stamped by the gateway after a
   *  successful attempt (differs from the requested default when a fallback produced the result),
   *  so cost pricing + ledger attribution land on the right model. In-process only. */
  provider?: string;
  modelId?: string;
  /** Rate-limit snapshot captured from this response's headers. In-process only. */
  rateLimitInfo?: UsageLimits;
};

/** One streamed delta. `text`/`reasoning` carry a `token`; `tool-call` carries the parsed call;
 *  `tool-result` carries the output of a provider-executed tool (already resolved by the provider,
 *  no local execution needed); `finish` reports why generation stopped; `usage` is terminal. */
export type ModelChunk =
  | { type: 'text'; token: string }
  | { type: 'reasoning'; token: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'tool-result'; callId: string; toolName: string; output: string }
  | { type: 'finish'; reason: string }
  | { type: 'usage'; usage: ModelUsage };

export interface ModelResult {
  text: string;
  /** Tool calls the model requested this turn. `finishReason: 'tool-calls'` ⇒ execute + continue. */
  toolCalls?: ToolCall[];
  usage?: ModelUsage;
  finishReason?: string;
}

export interface ImageResult {
  image: Uint8Array;
  mediaType: string;
}

export interface SpeechResult {
  audio: Uint8Array;
  mediaType: string;
}

export interface VideoResult {
  video: Uint8Array;
  mediaType: string;
}

export interface TranscriptionResult {
  text: string;
  segments?: Array<{ text: string; startSecond: number; endSecond: number }>;
  language?: string;
  durationInSeconds?: number;
  usage?: ModelUsage;
}

export interface RerankResult {
  ranking: Array<{ index: number; score: number; document: string }>;
  usage?: ModelUsage;
}

/** A provider instance the gateway resolved from config (no secrets). */
export interface ResolvedProviderConfig {
  id: string;
  type: string;
  baseUrl?: string;
  extra?: Record<string, string>;
}

/** One credential handle the gateway selected for this attempt.
 *  `admin_api_key` credentials (e.g. Anthropic `sk-ant-admin01-…`) are excluded from model
 *  inference calls and used only for admin-level queries (rate limits, usage reports). */
export interface ProviderCredential {
  id: string;
  accessToken: string;
  authType: 'api_key' | 'oauth' | 'admin_api_key';
  baseUrl?: string;
  priority: number;
}

/** A fully-resolved single call the gateway hands to a provider: which model, the messages/tools,
 *  the merged params, and the chosen provider + credential. `fetch` is injectable for offline
 *  tests; `signal` lets the caller abort cooperatively. */
export interface ModelCall {
  modelId: string;
  messages: ModelMessage[];
  tools?: ToolSpec[];
  searchToolProvider?: 'auto' | 'native' | 'brave' | 'ddgs';
  params: GenerationParams;
  provider: ResolvedProviderConfig;
  credential: ProviderCredential;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  /** Originating session, for observability span grouping. In-process telemetry only. */
  sessionId?: string;
  /** Max thinking/reasoning tokens for this call. Overrides profile's reasoningEffort mapping. */
  maxThinkingTokens?: number;
}

export interface ImageCall {
  modelId: string;
  prompt: string;
  size?: string;
  n?: number;
  provider: ResolvedProviderConfig;
  credential: ProviderCredential;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

export interface SpeechCall {
  modelId: string;
  text: string;
  voice?: string;
  provider: ResolvedProviderConfig;
  credential: ProviderCredential;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

export interface VideoCall {
  modelId: string;
  prompt: string;
  image?: string | URL | Uint8Array;
  mediaType?: string;
  aspectRatio?: string;
  resolution?: string;
  duration?: number;
  fps?: number;
  n?: number;
  provider: ResolvedProviderConfig;
  credential: ProviderCredential;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

export interface TranscriptionCall {
  modelId: string;
  audio: string | URL | Uint8Array;
  mediaType?: string;
  language?: string;
  provider: ResolvedProviderConfig;
  credential: ProviderCredential;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

export interface RerankCall {
  modelId: string;
  query: string;
  documents: string[];
  topN?: number;
  provider: ResolvedProviderConfig;
  credential: ProviderCredential;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

export interface EmbedCall {
  modelId: string;
  /** Batch of texts to embed; the provider returns one vector per input, in order. */
  texts: string[];
  provider: ResolvedProviderConfig;
  credential: ProviderCredential;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

export interface EmbedResult {
  /** One vector per input text, in order. */
  embeddings: number[][];
  /** Token usage for the batch, when the provider reports it (embeddings consume input tokens only). */
  usage?: ModelUsage;
}

/**
 * The provider contract. `type` matches the configured `Provider.type`. `descriptor` is the
 * self-describing catalog metadata (label, default base URL, key placeholder, extra fields…).
 * All generation calls are optional and capability-probed by the gateway, so a provider can be
 * image/video/embedding-only without pretending to support text generation.
 */
export interface ModelProvider {
  type: string;
  descriptor: ModelProviderDescriptor;
  stream?(call: ModelCall): AsyncIterable<ModelChunk>;
  /** Optional blocking variant. When absent the gateway aggregates `stream`. */
  complete?(call: ModelCall): Promise<ModelResult>;
  generateImage?(call: ImageCall): Promise<ImageResult>;
  generateVideo?(call: VideoCall): Promise<VideoResult>;
  generateSpeech?(call: SpeechCall): Promise<SpeechResult>;
  transcribe?(call: TranscriptionCall): Promise<TranscriptionResult>;
  rerank?(call: RerankCall): Promise<RerankResult>;
  /** Embed a batch of texts → one vector per input (+ token usage). Absent ⇒ no embedding model. */
  embed?(call: EmbedCall): Promise<EmbedResult>;
  /** Enumerate the provider's model catalogue (powers the connection test + model picker). */
  listModels?(
    provider: ResolvedProviderConfig,
    cred?: ProviderCredential,
    fetch?: typeof globalThis.fetch
  ): Promise<ModelInfo[]>;
  /** Native exact input-token count, when the provider exposes one. Best-effort: resolve to
   *  `undefined` on any error rather than throwing. */
  countTokens?(call: ModelCall): Promise<number | undefined>;
  /** Query current quota / credit balance without making a model call. Only implemented by
   *  providers that expose a dedicated limits endpoint (e.g. OpenRouter). Best-effort: resolve
   *  to `undefined` on any error rather than throwing. */
  getUsageLimits?(provider: ResolvedProviderConfig, cred: ProviderCredential): Promise<UsageLimits | undefined>;
}

/** Identity helper for authoring a provider with inferred types (mirrors defineChannel). */
export function defineProvider(provider: ModelProvider): ModelProvider {
  return provider;
}
