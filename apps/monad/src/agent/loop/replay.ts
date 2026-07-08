import type { ToolResult, ToolResultPart } from '#/capabilities/tools/types.ts';
import type { ModelContentPart, ModelMessage } from '../model/index.ts';
import type { ChatMessage } from './types.ts';

import { createHash } from 'node:crypto';
import { includeInContext } from '@monad/protocol';
import { z } from 'zod';

import { OBSERVATION_PREFIX } from '../prompts.ts';
import { stripAnsiFromToolOutput } from './ansi-output.ts';

const PERSISTED_TEXT_INLINE_LIMIT = 8_000;

/** Persisted shape of a tool call (`type: 'tool_call'` row's `data`). */
export interface PersistedToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  /** True for provider-executed tools (e.g. Anthropic/OpenAI native web_search). On replay,
   *  these degrade to text observations rather than native function-calling — Anthropic rejects
   *  stale tool_use IDs from a prior turn. */
  providerExecuted?: boolean;
}

/** Persisted shape of a tool result (`type: 'tool_result'` row's `data`). */
export interface PersistedToolResult {
  toolCallId: string;
  toolName: string;
  /** Full canonical tool result envelope used for replay/projection. */
  result?: PersistedToolResultEnvelope;
  /** The tool's original envelope before truncation/hooks, when available. */
  rawResult?: PersistedToolResultEnvelope;
  /** Derived text cache for older projections and quick display. */
  output: string;
  /** Derived display cache for older projections. */
  display?: unknown;
  /** true → tool succeeded; false / absent → legacy (treat `output` prefix as hint; new callers always set). */
  ok?: boolean;
}

type PersistedBytes = { type: 'bytes'; encoding: 'base64'; data: string };
interface PersistedArtifactRef {
  type: 'artifact_ref';
  kind: 'bytes' | 'text';
  bytes: number;
  sha256: string;
  preview?: string;
  truncated?: boolean;
}
type PersistedToolResultPart =
  | { type: 'text'; text: string | PersistedArtifactRef }
  | { type: 'image'; image: string | PersistedBytes | PersistedArtifactRef; mediaType?: string };
type PersistedToolModelContent = string | PersistedArtifactRef | PersistedToolResultPart[];
export interface PersistedToolResultEnvelope {
  modelContent: PersistedToolModelContent;
  displayContent?: unknown;
  metadata: unknown;
}

const persistedArtifactRefSchema = z.object({
  type: z.literal('artifact_ref'),
  kind: z.enum(['bytes', 'text']),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  preview: z.string().optional(),
  truncated: z.boolean().optional()
});

const legacyPersistedBytesSchema = z.object({
  type: z.literal('bytes'),
  encoding: z.literal('base64'),
  data: z.string()
});

const persistedToolResultPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.union([z.string(), persistedArtifactRefSchema]) }),
  z.object({
    type: z.literal('image'),
    image: z.union([z.string(), legacyPersistedBytesSchema, persistedArtifactRefSchema]),
    mediaType: z.string().optional()
  })
]);

const persistedToolResultEnvelopeSchema = z.object({
  modelContent: z.union([z.string(), persistedArtifactRefSchema, z.array(persistedToolResultPartSchema)]),
  displayContent: z.unknown().optional(),
  metadata: z.unknown()
});

const persistedToolResultSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  result: persistedToolResultEnvelopeSchema.optional(),
  rawResult: persistedToolResultEnvelopeSchema.optional(),
  output: z.string(),
  display: z.unknown().optional(),
  ok: z.boolean().optional()
});

export interface PersistedModelInputOverride {
  modelInput: {
    kind: 'skill';
    skillName: string;
    text: string;
  };
}

function asPersistedToolCall(data: unknown): PersistedToolCall | undefined {
  const d = data as Partial<PersistedToolCall> | null | undefined;
  return d && typeof d.toolCallId === 'string' && typeof d.toolName === 'string' ? (d as PersistedToolCall) : undefined;
}

function asPersistedToolResult(data: unknown): PersistedToolResult | undefined {
  const parsed = persistedToolResultSchema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function persistBytes(bytes: Uint8Array): PersistedArtifactRef {
  return { type: 'artifact_ref', kind: 'bytes', bytes: bytes.byteLength, sha256: sha256Bytes(bytes) };
}

function persistTextValue(text: string): string | PersistedArtifactRef {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (text.length <= PERSISTED_TEXT_INLINE_LIMIT) return text;
  return {
    type: 'artifact_ref',
    kind: 'text',
    bytes,
    sha256: sha256Text(text),
    preview: text.slice(0, PERSISTED_TEXT_INLINE_LIMIT),
    truncated: true
  };
}

function persistUnknown(value: unknown): unknown {
  if (value instanceof Uint8Array) return persistBytes(value);
  if (typeof value === 'string') return persistTextValue(value);
  if (Array.isArray(value)) return value.map(persistUnknown);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, persistUnknown(item)]));
}

function persistModelPart(part: ToolResultPart): PersistedToolResultPart {
  if (part.type === 'text') return { type: 'text', text: persistTextValue(part.text) };
  return {
    type: 'image',
    image: part.image instanceof Uint8Array ? persistBytes(part.image) : persistTextValue(part.image),
    ...(part.mediaType ? { mediaType: part.mediaType } : {})
  };
}

export function persistToolResultEnvelope(result: ToolResult<unknown>): PersistedToolResultEnvelope {
  return {
    modelContent:
      typeof result.modelContent === 'string'
        ? persistTextValue(result.modelContent)
        : result.modelContent.map((part) => persistModelPart(part)),
    ...(result.displayContent !== undefined ? { displayContent: persistUnknown(result.displayContent) } : {}),
    metadata: persistUnknown(result.metadata)
  };
}

function asModelInputOverride(data: unknown): PersistedModelInputOverride | undefined {
  const d = data as Partial<PersistedModelInputOverride> | null | undefined;
  return d?.modelInput?.kind === 'skill' &&
    typeof d.modelInput.skillName === 'string' &&
    typeof d.modelInput.text === 'string'
    ? (d as PersistedModelInputOverride)
    : undefined;
}

function modelOutputForToolResult(result: PersistedToolResult): string {
  const modelContent = result.result?.modelContent;
  if (typeof modelContent === 'string') return stripAnsiFromToolOutput(result.toolName, modelContent);
  if (modelContent && !Array.isArray(modelContent) && modelContent.type === 'artifact_ref') {
    return stripAnsiFromToolOutput(result.toolName, modelContent.preview ?? '');
  }
  if (Array.isArray(modelContent)) {
    const text = modelContent
      .filter((part): part is Extract<PersistedToolResultPart, { type: 'text' }> => part.type === 'text')
      .map((part) => (typeof part.text === 'string' ? part.text : (part.text.preview ?? '')))
      .join('\n');
    if (text) return stripAnsiFromToolOutput(result.toolName, text);
  }
  return stripAnsiFromToolOutput(result.toolName, result.output);
}

/**
 * Cross-turn cache of replayed message history, shared by every per-turn AgentLoop of one agent.
 * Keyed by session; the signature is `(length, lastMessageId)` — append/rewind/branch all change
 * one of those, so a stale hit is impossible (a miss just rebuilds, which is always correct).
 * Coarse LRU-capped so a long-lived daemon can't accumulate state for unbounded sessions.
 */
export class PromptReplayCache {
  private readonly entries = new Map<string, { sig: string; replayed: ModelMessage[] }>();
  constructor(private readonly maxSessions = 256) {}

  replay(sessionId: string, history: ChatMessage[]): ModelMessage[] {
    const sig = `${history.length}:${history.at(-1)?.id ?? ''}`;
    const hit = this.entries.get(sessionId);
    if (hit && hit.sig === sig) {
      this.entries.delete(sessionId); // touch-to-front
      this.entries.set(sessionId, hit);
      return hit.replayed;
    }
    const replayed = replayHistory(history);
    this.entries.delete(sessionId);
    this.entries.set(sessionId, { sig, replayed });
    if (this.entries.size > this.maxSessions) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return replayed;
  }
}

/** Coalesce adjacent assistant messages into one. A turn's preamble text and its tool call now
 * persist as separate rows (per-segment), but the model's native format — and what providers like
 * Anthropic require (roles must alternate) — is ONE assistant message holding `[text, tool-call]`
 * blocks. An empty text contributes no block. Adjacent user messages are also folded together for
 * model replay, preserving the timeline rows while avoiding user/user role runs in provider input. */
function coalesceAdjacentTurns(messages: ModelMessage[]): ModelMessage[] {
  const toBlocks = (c: string | ModelContentPart[]): ModelContentPart[] =>
    typeof c === 'string' ? (c ? [{ type: 'text', text: c }] : []) : c;
  const mergeUserContent = (
    a: string | ModelContentPart[],
    b: string | ModelContentPart[]
  ): string | ModelContentPart[] => {
    if (typeof a === 'string' && typeof b === 'string') return `${a}\n\n${b}`;
    return [...toBlocks(a), { type: 'text', text: '\n\n' }, ...toBlocks(b)];
  };
  const out: ModelMessage[] = [];
  for (const msg of messages) {
    const prev = out.at(-1);
    if (prev?.role === 'assistant' && msg.role === 'assistant') {
      prev.content = [...toBlocks(prev.content), ...toBlocks(msg.content)];
    } else if (prev?.role === 'user' && msg.role === 'user') {
      prev.content = mergeUserContent(prev.content, msg.content);
    } else {
      out.push(msg);
    }
  }
  return out;
}

/**
 * Rebuild persisted history into the messages sent to the model. A `tool_call` row whose `data`
 * pairs (by toolCallId) with the immediately-following `tool_result` row is replayed
 * structurally (native function-calling: assistant tool-call + tool result). Steps lacking that
 * structured data degrade to a plain user "Observation:" — and the call is dropped — so a
 * tool-call is NEVER emitted without its matching result (which providers reject). `error` rows
 * (surfaced failures) are UI-only and never replayed.
 */
export function replayHistory(history: ChatMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i] as ChatMessage;
    // An in-flight row (the assistant turn currently generating, or another live generative message)
    // has no settled content yet — skip it so an empty/partial assistant message never reaches the
    // model. It's served to clients via /messages, just not replayed into the prompt.
    if (m.stream?.status === 'pending' || m.stream?.status === 'streaming') continue;
    // Excluded messages never reach the model, summary, or token counts. `error`/`directive` default
    // to excluded; per-message `includeInContext` and atom types use the same registry-backed check.
    if (!includeInContext(m)) continue;

    // A user message immediately followed by an error (with no tool steps or assistant text
    // in between) is an orphaned turn: generation failed before the model replied. Skip it so
    // a retry doesn't produce two back-to-back user messages, which providers reject.
    if (m.role === 'user') {
      let nextSettled: ChatMessage | undefined;
      for (let j = i + 1; j < history.length; j++) {
        const n = history[j] as ChatMessage;
        if (n.stream?.status === 'pending' || n.stream?.status === 'streaming') continue;
        nextSettled = n;
        break;
      }
      if (nextSettled?.type === 'error') continue;
    }

    if (m.type === 'tool_call') {
      const call = asPersistedToolCall(m.data);
      const next = history[i + 1];
      const result = next?.type === 'tool_result' ? asPersistedToolResult(next.data) : undefined;

      if (call?.providerExecuted) {
        // Provider-executed tools (e.g. Anthropic/OpenAI native web_search) must not be replayed
        // as native function-calling — the provider would reject stale tool_use IDs from a prior
        // turn. Degrade to a plain text observation so the model still has the result as context.
        if (result && call.toolCallId === result.toolCallId) {
          out.push({
            role: 'user',
            content: `${OBSERVATION_PREFIX}[${call.toolName}]: ${modelOutputForToolResult(result)}`
          });
          i++; // consume the paired result row
        }
        continue;
      }

      if (call && result && call.toolCallId === result.toolCallId) {
        out.push({
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: call.toolCallId, toolName: call.toolName, input: call.input }]
        });
        out.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: result.toolCallId,
              toolName: result.toolName,
              output: modelOutputForToolResult(result)
            }
          ]
        });
        i++; // consumed the paired tool_result row
      }
      // else: drop the unpaired/dataless call; its result row (if any) degrades below.
      continue;
    }

    if (m.role === 'tool') {
      // A tool_result not consumed as a structured pair → degrade to a user observation.
      const result = asPersistedToolResult(m.data);
      out.push({
        role: 'user',
        content: `${OBSERVATION_PREFIX}${result ? modelOutputForToolResult(result) : m.text}`
      });
      continue;
    }

    out.push({
      role: m.role,
      content: m.role === 'user' ? (asModelInputOverride(m.data)?.modelInput.text ?? m.text) : m.text
    });
  }
  return coalesceAdjacentTurns(out);
}
