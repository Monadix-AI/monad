// The model layer's monad-native contract. The data types live in @monad/sdk-atom (the
// ai-sdk-free provider contract) and are re-exported here for the loop and the gateway. agent-core
// itself never imports ai-sdk — concrete providers do, inside @monad/atoms.

export type {
  EmbedResult,
  GenerationParams,
  ImageResult,
  ModelChunk,
  ModelContentPart,
  ModelMessage,
  ModelPrice,
  ModelResult,
  ModelUsage,
  SpeechResult,
  ToolCall,
  ToolSpec
} from '@monad/sdk-atom';

import type {
  EmbedResult,
  GenerationParams,
  ImageResult,
  ModelChunk,
  ModelMessage,
  ModelResult,
  ModelUsage,
  SpeechResult,
  ToolSpec
} from '@monad/sdk-atom';

/** A model spec ("providerId:modelId" or profile alias) supplied either eagerly or as a thunk.
 *  A thunk lets role assignments hot-reload — the tool resolves it per call instead of capturing
 *  a value at construction. */
export type ModelSpecRef = string | (() => string | undefined);

/** Resolve a {@link ModelSpecRef} to its current value (calls the thunk form). */
export function resolveSpec(ref: ModelSpecRef | undefined): string | undefined {
  return typeof ref === 'function' ? ref() : ref;
}

export interface ModelRequest {
  /** A profile alias, or a raw `"providerId:modelId"` spec (gateway router). */
  model: string;
  messages: ModelMessage[];
  params?: GenerationParams;
  /** Tools offered to the model for native function-calling. The loop executes the calls. */
  tools?: ToolSpec[];
  /** Originating session, for observability span grouping. In-process telemetry only. */
  sessionId?: string;
  /** Principal the turn is attributed to, for observability. In-process telemetry only. */
  userId?: string;
  /** Max thinking/reasoning tokens per model step. Absent → profile's reasoningEffort default. */
  maxThinkingTokens?: number;
}

export interface ImageRequest {
  /** Image-model spec: a raw "providerId:modelId" (e.g. "openai:dall-e-3") or a profile alias. */
  model: string;
  prompt: string;
  /** Provider-dependent size, e.g. "1024x1024". */
  size?: string;
  /** Number of images (default 1). */
  n?: number;
}

export interface SpeechRequest {
  /** Speech-model spec: a raw "providerId:modelId" (e.g. "openai:tts-1") or a profile alias. */
  model: string;
  text: string;
  /** Provider-dependent voice id, e.g. "alloy". */
  voice?: string;
}

export interface ModelRouter {
  stream(req: ModelRequest): AsyncIterable<ModelChunk>;
  complete(req: ModelRequest): Promise<ModelResult>;
  /** Absent on routers without an embedding model; callers fall back to keyword-only search.
   *  Returns vectors + token usage (stamped with the resolved provider/model for ledger booking). */
  embed?(texts: string[]): Promise<EmbedResult>;
  generateImage?(req: ImageRequest): Promise<ImageResult>;
  generateSpeech?(req: SpeechRequest): Promise<SpeechResult>;
  /**
   * Exact input-token count for a request, when the resolved provider exposes a native
   * count-tokens endpoint. Returns `undefined` otherwise (callers fall back to the char
   * heuristic). Best-effort and off the hot path; a network error resolves to `undefined`.
   */
  countTokens?(req: ModelRequest): Promise<number | undefined>;
}

/** Stamp the resolved provider+model that actually served the turn onto the usage, so cost pricing
 *  and ledger attribution use the model the fallback chain landed on (not the requested default). */
export function withResolvedModel(
  usage: ModelUsage | undefined,
  provider: string,
  modelId: string
): ModelUsage | undefined {
  // Return a copy rather than mutating the provider-supplied usage object (avoids a surprise
  // side-effect if a provider reuses/caches it).
  return usage ? { ...usage, provider, modelId } : usage;
}
