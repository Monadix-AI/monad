import type { NativeCliObservationEvent } from '@monad/protocol';

import { nativeCliObservationEventSchema } from '@monad/protocol';

export type ObservationRole = NativeCliObservationEvent['role'];
export type ObservationSource = NativeCliObservationEvent['source'];
export type JsonRecordEntry = {
  record: Record<string, unknown>;
  raw: string;
};

export function observation(args: {
  id: string;
  role: ObservationRole;
  text?: string;
  source: ObservationSource;
  providerEventType?: string;
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
    raw: args.raw
  });
  return parsed.success ? [parsed.data] : [];
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

function jsonObjectsInText(text: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char !== '}' || depth === 0) continue;
    depth -= 1;
    if (depth !== 0 || start < 0) continue;
    const record = parseJsonObject(text.slice(start, index + 1));
    if (record) records.push(record);
    start = -1;
  }
  return records;
}

export function jsonRecordEntries(text: string): JsonRecordEntry[] {
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
    .filter((entry): entry is JsonRecordEntry => !!entry);
  if (lineRecords.length > 0) return lineRecords;
  return jsonObjectsInText(text).map((record) => ({ record, raw: JSON.stringify(record) }));
}

export function textValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
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

export function contentEvents(args: {
  id: string;
  content: unknown;
  recordIndex: number;
  source: ObservationSource;
  providerEventType?: string;
  raw: unknown;
  baseSource?: string;
}): NativeCliObservationEvent[] {
  if (typeof args.content === 'string') {
    return observation({
      id: `${args.id}:json:${args.recordIndex}:${args.baseSource ?? 'message'}`,
      role: 'agent',
      text: args.content,
      source: args.source,
      providerEventType: args.providerEventType,
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
        role: 'agent',
        text,
        source: args.source,
        providerEventType: args.providerEventType,
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
        raw: args.raw
      });
    }
    return [];
  });
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
