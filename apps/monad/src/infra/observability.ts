/**
 * Daemon-side observability via OpenTelemetry (OTLP HTTP/protobuf).
 *
 * Disabled when config.observability.endpoint is empty and Developer Mode is off.
 * In Developer Mode the endpoint auto-defaults to http://localhost:6006.
 *
 * To start Phoenix manually:
 *   docker run -d -p 6006:6006 -p 4317:4317 -p 4318:4318 --name phoenix arizephoenix/phoenix
 */

import { SemanticConventions as OI } from '@arizeai/openinference-semantic-conventions';
import { OpenInferenceBatchSpanProcessor } from '@arizeai/openinference-vercel';
import { usageFromProviderMetadataJson } from '@monad/sdk-atom';
import {
  context,
  DiagConsoleLogger,
  DiagLogLevel,
  diag,
  metrics,
  type Span,
  SpanStatusCode,
  trace
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BasicTracerProvider, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

// Guards a value that's already meant to be numeric (the AI SDK records token counts as numbers).
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// Enrich AI-SDK spans with OpenInference attributes the openinference-vercel translator doesn't
// derive. Applied before super.onEnd() runs the translation — it mutates span.attributes the same
// way, so this is safe. Everything sourced here is already on the span (the AI SDK records it); we
// only re-key it into the OpenInference conventions Phoenix renders. Attribute keys come from the
// openinference-semantic-conventions package so a convention rename surfaces as a typecheck failure
// rather than a silently-dropped field.
class SessionAwareSpanProcessor extends OpenInferenceBatchSpanProcessor {
  override onEnd(span: ReadableSpan): void {
    const attrs = span.attributes as Record<string, unknown>;

    // Session / user grouping (Phoenix Sessions tab + per-user filtering) — both ride along as
    // AI-SDK telemetry metadata, which the translator keeps under `metadata.*`; re-key to the
    // OpenInference top-level conventions Phoenix groups by.
    const sid = attrs['ai.telemetry.metadata.sessionId'] ?? attrs['ai.settings.context.sessionId'];
    if (typeof sid === 'string' && sid && !attrs[OI.SESSION_ID]) attrs[OI.SESSION_ID] = sid;
    const uid = attrs['ai.telemetry.metadata.userId'] ?? attrs['ai.settings.context.userId'];
    if (typeof uid === 'string' && uid && !attrs[OI.USER_ID]) attrs[OI.USER_ID] = uid;

    // Token-count details the translator omits (it only maps prompt/completion).
    const reasoningTokens = num(attrs['ai.usage.reasoningTokens']);
    if (reasoningTokens !== undefined) attrs[OI.LLM_TOKEN_COUNT_COMPLETION_DETAILS_REASONING] = reasoningTokens;
    const cacheRead = num(attrs['ai.usage.cachedInputTokens']);
    if (cacheRead !== undefined) attrs[OI.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ] = cacheRead;
    const totalTokens = num(attrs['ai.usage.totalTokens']);
    if (totalTokens !== undefined) attrs[OI.LLM_TOKEN_COUNT_TOTAL] = totalTokens;

    // Real provider-reported cost (OpenRouter) + cache-write tokens (Anthropic/Bedrock) live inside
    // the provider metadata blob. Parsing is delegated to @monad/sdk-atom — the single owner of
    // provider-shape knowledge — so it can't drift from the cost ledger's extraction. Free models
    // legitimately report no cost.
    const pm = attrs['ai.response.providerMetadata'];
    if (typeof pm === 'string') {
      const { costUsd, cacheWriteTokens } = usageFromProviderMetadataJson(pm);
      if (costUsd !== undefined) attrs[OI.LLM_COST_TOTAL] = costUsd;
      if (cacheWriteTokens !== undefined) attrs[OI.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE] = cacheWriteTokens;
    }

    // Reasoning as a distinct, collapsible content block (not folded into the answer text).
    const reasoning = attrs['ai.response.reasoning'];
    if (typeof reasoning === 'string' && reasoning.trim()) {
      const answer = typeof attrs['ai.response.text'] === 'string' ? (attrs['ai.response.text'] as string) : '';
      const m = `${OI.LLM_OUTPUT_MESSAGES}.0.message`;
      attrs[`${m}.${OI.MESSAGE_ROLE}`] = 'assistant';
      attrs[`${m}.${OI.MESSAGE_CONTENTS}.0.${OI.MESSAGE_CONTENT_TYPE}`] = 'reasoning';
      attrs[`${m}.${OI.MESSAGE_CONTENTS}.0.${OI.MESSAGE_CONTENT_TEXT}`] = reasoning;
      if (answer) {
        attrs[`${m}.${OI.MESSAGE_CONTENTS}.1.${OI.MESSAGE_CONTENT_TYPE}`] = 'text';
        attrs[`${m}.${OI.MESSAGE_CONTENTS}.1.${OI.MESSAGE_CONTENT_TEXT}`] = answer;
      }
    }

    // Tool catalogue offered to the model (translator maps tool *calls*, not the *definitions*).
    const tools = attrs['ai.prompt.tools'];
    if (Array.isArray(tools)) {
      tools.forEach((t, i) => {
        if (typeof t === 'string') attrs[`${OI.LLM_TOOLS}.${i}.${OI.TOOL_JSON_SCHEMA}`] = t;
      });
    }

    super.onEnd(span);
  }
}

let _enabled = false;

export function resolveObservabilityEndpoint(opts: { endpoint?: string; developerMode: boolean }): string {
  return opts.endpoint || (opts.developerMode ? 'http://localhost:6006' : '');
}

/** Call once at startup with the resolved config endpoint. Returns true when OTel was activated. */
export function initObservability(endpoint: string, version: string): boolean {
  if (!endpoint) return false;

  if (Bun.env.NODE_ENV === 'development') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
  }

  // Without an async-context manager the AI SDK's parent span (`ai.streamText`) and its child
  // (`ai.streamText.doStream`) land in separate traces — Bun needs this enabled explicitly.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'monad-daemon',
    [ATTR_SERVICE_VERSION]: version
  });

  // The Vercel AI SDK emits spans with its own `ai.*` / `gen_ai.*` attribute namespace; Phoenix
  // reads OpenInference attributes (`input.value`, `output.value`, `llm.*`). This processor
  // translates AI-SDK spans into OpenInference on the way out — without it Phoenix shows the
  // spans but with empty input/output. No spanFilter: our own `monad.*` spans pass through as-is.
  const traceExporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces` });
  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [new SessionAwareSpanProcessor({ exporter: traceExporter })]
  });
  trace.setGlobalTracerProvider(tracerProvider);

  const metricExporter = new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` });
  const meterProvider = new MeterProvider({
    resource,
    readers: [new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 30_000 })]
  });
  metrics.setGlobalMeterProvider(meterProvider);

  _enabled = true;
  return true;
}

function _isObservabilityEnabled(): boolean {
  return _enabled;
}

/** Wrap an async fn in a named span. Marks the span as error on exception. */
async function _withSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
  if (!_enabled) return fn({ end() {}, setAttribute() {}, setStatus() {}, recordException() {} } as unknown as Span);
  const tracer = trace.getTracer('monad-daemon');
  return tracer.startActiveSpan(name, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Daemon-wide counter for agent turns. Access via `agentTurnCounter.add(1, { model })`. */
const _agentTurnCounter = {
  add(value: number, attributes?: Record<string, string>): void {
    if (!_enabled) return;
    metrics.getMeter('monad-daemon').createCounter('monad.agent.turns').add(value, attributes);
  }
};
