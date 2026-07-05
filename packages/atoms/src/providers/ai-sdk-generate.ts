import type { GenerationParams, ModelCall, ModelChunk, ModelResult, UsageLimits } from '@monad/sdk-atom';
import type { LanguageModel } from 'ai';
import type { AiSdkProviderSpec, ProviderOpts } from './ai-sdk-adapter.ts';

import { generateText, streamText } from 'ai';

import { splitSystem } from './ai-sdk-messages.ts';
import { buildTelemetry } from './ai-sdk-telemetry.ts';
import { buildSdkTools, toModelToolCalls } from './ai-sdk-tools.ts';
import { toUsage, wrapFetchForRateLimits } from './ai-sdk-usage.ts';

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

function buildLanguageModel(spec: AiSdkProviderSpec, call: ModelCall): LanguageModel {
  if (!spec.build) throw new Error(`provider "${spec.type}" does not support text generation`);
  return spec.build(call);
}

export async function* streamViaAiSdk(call: ModelCall, spec: AiSdkProviderSpec): AsyncIterable<ModelChunk> {
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

export async function completeViaAiSdk(call: ModelCall, spec: AiSdkProviderSpec): Promise<ModelResult> {
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
