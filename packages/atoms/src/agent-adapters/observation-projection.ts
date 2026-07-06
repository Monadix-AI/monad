import type { NativeCliObservationEvent } from '@monad/protocol';
import type {
  NativeCliObservationJsonRecordEntry,
  NativeCliObservationMessageGroupProjector,
  NativeCliObservationProjector,
  NativeCliObservationRecordProjector
} from '@monad/sdk-atom';

import { nativeCliObservationEventSchema } from '@monad/protocol';

export type ObservationRole = NativeCliObservationEvent['role'];
export type ObservationSource = NativeCliObservationEvent['source'];
export type {
  NativeCliObservationJsonRecordEntry,
  NativeCliObservationMessageGroupProjector,
  NativeCliObservationProjector,
  NativeCliObservationRecordProjector
};

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
  role: ObservationRole;
  text?: string;
  source: ObservationSource;
  providerEventType?: string;
  createdAt?: string;
  raw?: unknown;
  preserveWhitespace?: boolean;
}): NativeCliObservationEvent[] {
  const text = args.preserveWhitespace ? args.text : args.text?.trim();
  if (!text) return [];
  const parsed = nativeCliObservationEventSchema.safeParse({
    id: args.id,
    role: args.role,
    text,
    source: args.source,
    providerEventType: args.providerEventType,
    createdAt: args.createdAt,
    raw: args.raw
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
}): NativeCliObservationEvent[] {
  return observation({
    ...args,
    role: 'agent',
    text: args.text ?? 'Thinking…',
    providerEventType: args.providerEventType ?? 'thinking'
  });
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function jsonRecordEntries(text: string): NativeCliObservationJsonRecordEntry[] {
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
    .filter((entry): entry is NativeCliObservationJsonRecordEntry => !!entry);
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
): NativeCliObservationEvent[] {
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
}): NativeCliObservationEvent[] {
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
