import type { MeshAgentOutputEvent } from '@monad/sdk-atom';
import type { LegacyProviderRuntimeHandle } from '../legacy/runtime.ts';

import { z } from 'zod';

import { compactObject } from '../adapter-shared.ts';

// Wire contract for the Gemini CLI `--output-format stream-json` channel: one JSON object per line
// (JSONL). This mirrors `@google/gemini-cli-core`'s `JsonStreamEvent` union and `JsonStreamEventType`
// enum, reverse-verified against the `StreamJsonFormatter.emitEvent` call sites in gemini-cli
// v0.49.0. It is the single source of truth both MeshAgent adapters parse against: Qwen Code is a
// gemini-cli fork and emits the identical schema, so `gemini` and `qwen` share this one definition.
//
// Fields the daemon does not consume (`timestamp`, `stats`) stay optional and every object keeps a
// `catchall`, so a newer CLI that adds fields — or an unknown event type — is skipped rather than
// wedging the parse (schema-first at the runtime boundary; see docs/engineering/conventions.md §3).

export const GEMINI_STREAM_JSON_EVENT_TYPES = [
  'init',
  'message',
  'tool_use',
  'tool_result',
  'error',
  'result'
] as const;

const geminiStreamJsonErrorInfoSchema = z
  .object({
    type: z.string().optional(),
    message: z.string()
  })
  .catchall(z.unknown());

export const geminiStreamJsonInitSchema = z
  .object({
    type: z.literal('init'),
    timestamp: z.string().optional(),
    session_id: z.string().optional(),
    model: z.string().optional()
  })
  .catchall(z.unknown());

export const geminiStreamJsonMessageSchema = z
  .object({
    type: z.literal('message'),
    timestamp: z.string().optional(),
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    delta: z.boolean().optional()
  })
  .catchall(z.unknown());

export const geminiStreamJsonToolUseSchema = z
  .object({
    type: z.literal('tool_use'),
    timestamp: z.string().optional(),
    tool_name: z.string().optional(),
    tool_id: z.union([z.string(), z.number()]).optional(),
    parameters: z.unknown().optional()
  })
  .catchall(z.unknown());

export const geminiStreamJsonToolResultSchema = z
  .object({
    type: z.literal('tool_result'),
    timestamp: z.string().optional(),
    tool_id: z.union([z.string(), z.number()]).optional(),
    status: z.enum(['success', 'error']).optional(),
    output: z.string().optional(),
    error: geminiStreamJsonErrorInfoSchema.optional()
  })
  .catchall(z.unknown());

export const geminiStreamJsonErrorSchema = z
  .object({
    type: z.literal('error'),
    timestamp: z.string().optional(),
    severity: z.enum(['warning', 'error']).optional(),
    message: z.string()
  })
  .catchall(z.unknown());

export const geminiStreamJsonResultSchema = z
  .object({
    type: z.literal('result'),
    timestamp: z.string().optional(),
    status: z.enum(['success', 'error']).optional(),
    error: geminiStreamJsonErrorInfoSchema.optional(),
    stats: z.unknown().optional()
  })
  .catchall(z.unknown());

export const geminiStreamJsonEventSchema = z.discriminatedUnion('type', [
  geminiStreamJsonInitSchema,
  geminiStreamJsonMessageSchema,
  geminiStreamJsonToolUseSchema,
  geminiStreamJsonToolResultSchema,
  geminiStreamJsonErrorSchema,
  geminiStreamJsonResultSchema
]);

export type GeminiStreamJsonErrorInfo = z.infer<typeof geminiStreamJsonErrorInfoSchema>;
export type GeminiStreamJsonInit = z.infer<typeof geminiStreamJsonInitSchema>;
export type GeminiStreamJsonMessage = z.infer<typeof geminiStreamJsonMessageSchema>;
export type GeminiStreamJsonToolUse = z.infer<typeof geminiStreamJsonToolUseSchema>;
export type GeminiStreamJsonToolResult = z.infer<typeof geminiStreamJsonToolResultSchema>;
export type GeminiStreamJsonError = z.infer<typeof geminiStreamJsonErrorSchema>;
export type GeminiStreamJsonResult = z.infer<typeof geminiStreamJsonResultSchema>;
export type GeminiStreamJsonEvent = z.infer<typeof geminiStreamJsonEventSchema>;

// Gemini CLI's `--output-format stream-json` channel: one JSON object per line (JSONL). Unlike Qwen
// Code (which rewrote its output layer to the Claude-Code `SDKMessage` protocol — see
// `qwen-stream-json.ts`), gemini still emits the flat `JsonStreamEvent` union. Every line is validated
// against the `@monad/protocol` schema — the single source of truth for the wire shape — and mapped to
// the daemon's MeshAgent output contract via a type-keyed dispatch table, mirroring the codex
// adapter's notification handlers. Adding a future event type is one table entry, not another `if`.

// The assistant reply streams as incremental `message` deltas; the terminal `result` event carries
// stats, not text. Accumulate per session so the turn-final `agent_message` can carry the full reply
// — the only shape the host posts to the Workplace wall. Keyed on the live session handle (a stable
// per-session object); a `WeakMap` avoids widening the handle type and never leaks.
const turnTextByHandle = new WeakMap<object, string>();

interface StreamJsonAccumulator {
  get(): string;
  append(text: string): void;
  reset(): void;
}

function accumulatorFor(handle: LegacyProviderRuntimeHandle | undefined): StreamJsonAccumulator {
  if (handle) {
    return {
      get: () => turnTextByHandle.get(handle) ?? '',
      append: (text) => turnTextByHandle.set(handle, (turnTextByHandle.get(handle) ?? '') + text),
      reset: () => turnTextByHandle.delete(handle)
    };
  }
  // No handle (unit tests, one-shot event probes): a full turn arrives in a single chunk, so a
  // call-local buffer is enough.
  let local = '';
  return {
    get: () => local,
    append: (text) => {
      local += text;
    },
    reset: () => {
      local = '';
    }
  };
}

type StreamJsonHandler = (event: GeminiStreamJsonEvent, acc: StreamJsonAccumulator) => MeshAgentOutputEvent[];

const GEMINI_STREAM_JSON_HANDLERS: Record<GeminiStreamJsonEvent['type'], StreamJsonHandler> = {
  init: (event, acc) => {
    acc.reset();
    if (event.type !== 'init' || !event.session_id) return [];
    return [
      {
        type: 'session_ref',
        payload: compactObject({ providerSessionRef: event.session_id, model: event.model })
      }
    ];
  },
  message: (event, acc) => {
    if (event.type !== 'message') return [];
    // `role: 'user'` is the CLI echoing our own prompt back and marks the start of a turn; drop it
    // (surfacing it would double the input as agent output) and clear any prior turn's accumulation.
    if (event.role === 'user') {
      acc.reset();
      return [];
    }
    if (!event.content) return [];
    acc.append(event.content);
    return [{ type: 'agent_message', payload: { text: event.content } }];
  },
  tool_use: (event) => {
    if (event.type !== 'tool_use') return [];
    return [
      {
        type: 'tool_call',
        payload: compactObject({ callId: event.tool_id, tool: event.tool_name, input: event.parameters })
      }
    ];
  },
  tool_result: (event) => {
    if (event.type !== 'tool_result') return [];
    return [
      {
        type: 'tool_result',
        payload: compactObject({ callId: event.tool_id, output: event.output ?? event.error?.message })
      }
    ];
  },
  error: (event) => {
    if (event.type !== 'error') return [];
    // `warning` severity (loop detected, execution blocked, non-fatal max-turns) is already visible
    // in the raw output card; only escalate a genuine `error` to the provider_error path, which
    // rejects session startup and marks the turn failed.
    if (event.severity === 'warning') return [];
    return [{ type: 'provider_error', payload: compactObject({ message: event.message, severity: event.severity }) }];
  },
  result: (event, acc) => {
    if (event.type !== 'result') return [];
    if (event.status === 'error') {
      acc.reset();
      return [
        {
          type: 'provider_error',
          payload: compactObject({
            message: event.error?.message ?? 'Gemini reported a failed result',
            code: event.error?.type
          })
        }
      ];
    }
    const text = acc.get();
    acc.reset();
    return [{ type: 'agent_message', payload: compactObject({ text: text || undefined, final: true }) }];
  }
};

/** Parse a Gemini CLI stream-json chunk (one or more complete JSONL lines) into MeshAgent output
 *  events. The `qwen` adapter does NOT use this — Qwen Code emits a different (Claude-Code) protocol. */
export function parseGeminiStreamJson(chunk: string, handle?: LegacyProviderRuntimeHandle): MeshAgentOutputEvent[] {
  const acc = accumulatorFor(handle);
  const events: MeshAgentOutputEvent[] = [];
  for (const rawLine of chunk.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = geminiStreamJsonEventSchema.safeParse(json);
    if (!parsed.success) continue;
    events.push(...GEMINI_STREAM_JSON_HANDLERS[parsed.data.type](parsed.data, acc));
  }
  return events;
}

export function createGeminiStreamJsonParser(): (chunk: string) => MeshAgentOutputEvent[] {
  const handle = { kill() {} } as LegacyProviderRuntimeHandle;
  return (chunk) => parseGeminiStreamJson(chunk, handle);
}

/** Whether a raw buffer contains at least one recognizable Gemini stream-json event — used to pick
 *  between the stream-json and checkpoint event formats without a handle-bound accumulator. */
export function hasGeminiStreamJsonEvents(raw: string): boolean {
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    try {
      if (geminiStreamJsonEventSchema.safeParse(JSON.parse(line)).success) return true;
    } catch {}
  }
  return false;
}
