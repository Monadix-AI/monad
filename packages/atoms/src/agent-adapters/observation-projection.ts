import type { AgentObservationDiagnostic, MeshAgentObservationEvent } from '@monad/protocol';
import type {
  MeshAgentObservationActivity,
  MeshAgentObservationJsonRecordEntry,
  MeshAgentObservationMessageGroupProjector,
  MeshAgentObservationProjector,
  MeshAgentObservationRecordProjector
} from '@monad/sdk-atom';

import { meshAgentObservationEventSchema } from '@monad/protocol';

export type ObservationRole = MeshAgentObservationEvent['role'];
export type ObservationSource = MeshAgentObservationEvent['source'];
export type {
  MeshAgentObservationActivity,
  MeshAgentObservationJsonRecordEntry,
  MeshAgentObservationMessageGroupProjector,
  MeshAgentObservationProjector,
  MeshAgentObservationRecordProjector
};

const TERMINAL_EVENT_TYPES = new Set(['turn/completed', 'result', 'error', 'server_error', 'turn-end']);
const TOOL_RESULT_EVENT_TYPES = new Set([
  'tool_result',
  'function_call_output',
  'custom_tool_call_output',
  'item/toolcalloutput'
]);

function threadStatusIsIdle(raw: unknown): boolean {
  const record = recordValue(raw);
  const params = recordValue(record?.params);
  const status = recordValue(params?.status);
  return textValue(status?.type, params?.type, params?.status) === 'idle';
}

/** Shared classifier for adapters whose projected events follow the common conventions: a terminal
 *  `providerEventType` (result / turn completed / error / a thread going idle), thinking events tagged
 *  with a reasoning/thinking/plan type, and `role` carrying tool/user/system/agent. Adapters with an
 *  exotic vocabulary can supply their own `classifyActivity`; most just reference this. Provider event
 *  strings live HERE (adapter side), never in a consumer. `system` (a turn-start / status notice) still
 *  counts as in-flight for generating but yields no UI phase. */
export function classifyObservationActivity(
  event: MeshAgentObservationEvent
): MeshAgentObservationActivity | undefined {
  const type = event.providerEventType?.toLowerCase() ?? '';
  if (type && TERMINAL_EVENT_TYPES.has(type)) return 'turn-end';
  if (event.providerEventType === 'thread/status/changed')
    return threadStatusIsIdle(event.provenance.rawEvents[0]) ? 'turn-end' : 'status';
  if (event.role === 'tool') {
    return type && TOOL_RESULT_EVENT_TYPES.has(type) ? 'tool-result' : 'tool-call';
  }
  if (type.includes('reasoning') || type.includes('thinking') || type.includes('plan')) return 'thinking';
  if (event.role === 'user') return 'user';
  if (event.role === 'system') return 'system';
  return 'message';
}

/** Shared default for `isStreamingFragment`: structured-stream providers all name partial
 *  token events with a `*delta`/`*chunk` suffix. Adapters with a different convention override it. */
export function isStreamingObservationFragment(event: MeshAgentObservationEvent): boolean {
  const type = event.providerEventType?.toLowerCase() ?? '';
  return type.endsWith('/delta') || type.endsWith('_delta') || type.endsWith('delta') || type.includes('chunk');
}

function isoFromMs(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function providerEpochMsTimestamp(value: number | undefined): string | undefined {
  return value === undefined ? undefined : isoFromMs(value);
}

export function providerEpochSecondsTimestamp(value: number | undefined): string | undefined {
  return value === undefined ? undefined : isoFromMs(value * 1000);
}

export function providerIsoTimestamp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : isoFromMs(parsed);
}

export function observation(args: {
  id: string;
  projection?: MeshAgentObservationEvent['projection'];
  role: ObservationRole;
  text?: string;
  source: ObservationSource;
  providerEventType?: string;
  diagnostic?: AgentObservationDiagnostic;
  createdAt?: string;
  raw?: unknown;
  rawEvents?: unknown[];
  preserveWhitespace?: boolean;
}): MeshAgentObservationEvent[] {
  const text = args.preserveWhitespace ? args.text : args.text?.trim();
  if (!text) return [];
  const parsed = meshAgentObservationEventSchema.safeParse({
    id: args.id,
    projection: args.projection,
    role: args.role,
    text,
    source: args.source,
    providerEventType: args.providerEventType,
    diagnostic: args.diagnostic,
    createdAt: args.createdAt,
    provenance: { rawEvents: args.rawEvents ?? [args.raw] }
  });
  return parsed.success ? [parsed.data] : [];
}

export function thinkingObservation(args: {
  id: string;
  text?: string;
  source: ObservationSource;
  providerEventType?: string;
  createdAt?: string;
  raw?: unknown;
  preserveWhitespace?: boolean;
}): MeshAgentObservationEvent[] {
  return observation({
    ...args,
    role: 'agent',
    text: args.text ?? 'Thinking…',
    providerEventType: args.providerEventType ?? 'thinking'
  });
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = z.json().parse(JSON.parse(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function jsonRecordEntries(text: string): MeshAgentObservationJsonRecordEntry[] {
  if (!text.includes('{')) return [];
  const trimmed = text.trim();
  const whole = parseJsonObject(trimmed);
  if (whole) return [{ record: whole, raw: trimmed }];
  const lineRecords = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => {
      const record = parseJsonObject(line);
      return record ? { record, raw: line } : undefined;
    })
    .filter((entry): entry is MeshAgentObservationJsonRecordEntry => !!entry);
  if (lineRecords.length > 0) return lineRecords;
  return [];
}

export function textValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function compactJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim() || undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function commandText(command: unknown): string | undefined {
  if (Array.isArray(command))
    return (
      command
        .map((part) => String(part))
        .join(' ')
        .trim() || undefined
    );
  return textValue(command);
}

export function resultMarkerText(record: Record<string, unknown>): string {
  const subtype = textValue(record.subtype) ?? (record.is_error ? 'error' : 'completed');
  const stopReason = textValue(record.stop_reason);
  return stopReason ? `Result: ${subtype} (${stopReason})` : `Result: ${subtype}`;
}

// Streaming deltas carry their own boundary whitespace (a space after a period, a
// leading space on the next fragment). Trimming here would drop it, and the chunk
// merge cannot re-insert a space after clause punctuation — so keep deltas verbatim.
export function rawTextValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

export function permissionDenialEvents(
  id: string,
  denials: unknown,
  source: ObservationSource,
  recordIndex?: number
): MeshAgentObservationEvent[] {
  if (!Array.isArray(denials)) return [];
  const prefix = recordIndex === undefined ? id : `${id}:json:${recordIndex}`;
  return denials.flatMap((denial, index) => {
    if (!denial || typeof denial !== 'object' || Array.isArray(denial)) return [];
    const record = denial as Record<string, unknown>;
    const toolInput = record.tool_input;
    const input =
      toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)
        ? (toolInput as Record<string, unknown>)
        : {};
    const label = textValue(record.tool_name) ?? 'tool';
    const detail = textValue(input.command, input.description);
    return observation({
      id: `${prefix}:denial:${index}`,
      role: 'tool',
      text: detail ? `Permission blocked ${label}: ${detail}` : `Permission blocked ${label}`,
      source,
      providerEventType: 'permission_denial',
      raw: denial
    });
  });
}

export function contentEvents(args: {
  id: string;
  content: unknown;
  recordIndex: number;
  source: ObservationSource;
  providerEventType?: string;
  createdAt?: string;
  raw: unknown;
  baseSource?: string;
  textRole?: Extract<ObservationRole, 'agent' | 'user'>;
}): MeshAgentObservationEvent[] {
  const textRole = args.textRole ?? 'agent';
  if (typeof args.content === 'string') {
    return observation({
      id: `${args.id}:json:${args.recordIndex}:${args.baseSource ?? 'message'}`,
      role: textRole,
      text: args.content,
      source: args.source,
      providerEventType: args.providerEventType,
      createdAt: args.createdAt,
      raw: args.raw
    });
  }
  if (!Array.isArray(args.content)) return [];
  return args.content.flatMap((part, partIndex) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
    const item = part as Record<string, unknown>;
    const text = textValue(item.text, item.content);
    if (item.type === 'text' && text) {
      return observation({
        id: `${args.id}:json:${args.recordIndex}:${args.baseSource ?? 'message'}:${partIndex}`,
        role: textRole,
        text,
        source: args.source,
        providerEventType: args.providerEventType,
        createdAt: args.createdAt,
        raw: args.raw
      });
    }
    if (item.type === 'tool_use') {
      const tool = textValue(item.name, item.tool) ?? 'tool';
      const input = item.input ?? item.args ?? item.arguments;
      const inputText = input === undefined ? '' : ` ${typeof input === 'string' ? input : JSON.stringify(input)}`;
      return observation({
        id: `${args.id}:json:${args.recordIndex}:tool:${partIndex}`,
        role: 'tool',
        text: `Tool call ${tool}${inputText}`,
        source: args.source,
        providerEventType: args.providerEventType,
        createdAt: args.createdAt,
        raw: args.raw
      });
    }
    if (item.type === 'tool_result') {
      return observation({
        id: `${args.id}:json:${args.recordIndex}:tool-result:${partIndex}`,
        role: 'tool',
        text: textValue(item.content, item.output, item.result) ?? JSON.stringify(item.content ?? item),
        source: args.source,
        providerEventType: args.providerEventType,
        createdAt: args.createdAt,
        raw: args.raw
      });
    }
    return [];
  });
}

import { z } from 'zod';
