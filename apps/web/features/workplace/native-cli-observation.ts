import type { NativeCliObservationEvent, NativeCliProvider, NativeCliUsageResponse } from '@monad/protocol';

import { claudeRecordEvents, isClaudeObservationMessage } from './native-cli-observation-claude.ts';
import {
  codexAppServerRecordEvents,
  codexExecRecordEvents,
  isCodexObservationNotification
} from './native-cli-observation-codex.ts';
import { geminiRecordEvents } from './native-cli-observation-gemini.ts';
import { isQwenObservationMessage, qwenRecordEvents } from './native-cli-observation-qwen.ts';
import {
  jsonRecordEntries,
  observation,
  rawTextValue,
  resultMarkerText,
  textValue
} from './native-cli-observation-shared.ts';

type JsonRecordEntry = {
  record: Record<string, unknown>;
  raw: string;
};
type CodexMessageGroup = {
  key: string;
  kind: 'agent' | 'user';
  raw: Record<string, unknown>[];
  rawLines: string[];
  fragments: string[];
  startedText?: string;
  completedText?: string;
};
type ParsedTimelineEntry =
  | { kind: 'events'; events: NativeCliObservationEvent[] }
  | { kind: 'codex-message'; key: string };
type NativeCliUsageLimitRow = {
  id: string;
  label: string;
  percent: number;
  meterPercent?: number;
  resetLabel?: string;
  valueLabel?: string;
};
export type NativeCliUsageLimitMeter = {
  title: string;
  rows: NativeCliUsageLimitRow[];
};

function rawJsonObservation(
  id: string,
  rawLine: string,
  record: Record<string, unknown>,
  recordIndex: number
): NativeCliObservationEvent[] {
  return observation({
    id: `${id}:json:${recordIndex}:raw`,
    role: 'system',
    text: rawLine,
    source: 'unknown',
    providerEventType: 'raw_json',
    raw: record,
    preserveWhitespace: true
  });
}

function unknownJsonRpcError(
  id: string,
  record: Record<string, unknown>,
  recordIndex: number
): NativeCliObservationEvent[] {
  if (record.error && typeof record.error === 'object' && !Array.isArray(record.error)) {
    const error = record.error as Record<string, unknown>;
    return observation({
      id: `${id}:json:${recordIndex}:error`,
      role: 'system',
      text: textValue(error.message, error.code) ?? JSON.stringify(error),
      source: 'unknown',
      providerEventType: 'error',
      raw: record
    });
  }
  return [];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function codexItemText(item: Record<string, unknown> | undefined): string | undefined {
  if (!item) return undefined;
  const direct = rawTextValue(item.text);
  if (direct !== undefined) return direct;
  const content = item.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
    const text = rawTextValue((part as Record<string, unknown>).text, (part as Record<string, unknown>).content);
    return text === undefined ? [] : [text];
  });
  return parts.length > 0 ? parts.join('') : undefined;
}

function codexMessageGroup(
  record: Record<string, unknown>
): { key: string; kind: CodexMessageGroup['kind'] } | undefined {
  const method = textValue(record.method);
  if (!method) return undefined;
  const params = recordValue(record.params);
  if (!params) return undefined;
  const item = recordValue(params.item);
  if (method === 'item/started' || method === 'item/completed') {
    const itemType = textValue(item?.type);
    const kind = itemType === 'agentMessage' ? 'agent' : itemType === 'userMessage' ? 'user' : undefined;
    if (!kind) return undefined;
    const itemId = textValue(item?.id);
    if (!itemId) return undefined;
    return { key: [textValue(params.threadId), textValue(params.turnId), itemId].filter(Boolean).join(':'), kind };
  }
  if (method === 'item/agentMessage/delta') {
    const itemId = textValue(params.itemId);
    if (!itemId) return undefined;
    return {
      key: [textValue(params.threadId), textValue(params.turnId), itemId].filter(Boolean).join(':'),
      kind: 'agent'
    };
  }
  return undefined;
}

function codexMessageLifecycleText(record: Record<string, unknown>): {
  fragment?: string;
  startedText?: string;
  completedText?: string;
} {
  const method = textValue(record.method);
  const params = recordValue(record.params);
  if (!method || !params) return {};
  if (method === 'item/agentMessage/delta') return { fragment: rawTextValue(params.delta, params.text) };
  const item = recordValue(params.item);
  const itemType = textValue(item?.type);
  if (itemType !== 'agentMessage' && itemType !== 'userMessage') return {};
  const text = codexItemText(item);
  if (method === 'item/started') return { startedText: text };
  if (method === 'item/completed') return { completedText: text };
  return {};
}

function codexMessageGroupEvent(id: string, group: CodexMessageGroup): NativeCliObservationEvent[] {
  const text = group.completedText ?? group.startedText ?? group.fragments.join('');
  return observation({
    id: `${id}:json:${group.key}:${group.kind}-message`,
    role: group.kind,
    text,
    source: 'codex-app-server',
    providerEventType: group.kind === 'agent' ? 'item/agentMessage' : 'item/userMessage',
    raw: group.rawLines.length > 1 ? group.rawLines : (group.raw[0] ?? group.rawLines[0])
  });
}

function recordEvents(
  id: string,
  provider: NativeCliProvider | string | undefined,
  record: Record<string, unknown>,
  recordIndex: number
): NativeCliObservationEvent[] {
  if (isCodexObservationNotification(record)) {
    const appServer = codexAppServerRecordEvents(id, record, recordIndex);
    if (appServer.length > 0) return appServer;
  }
  if (provider === 'codex') {
    const codex = codexExecRecordEvents(id, record, recordIndex);
    if (codex.length > 0) return codex;
  }
  if (provider === 'claude-code' && isClaudeObservationMessage(record)) {
    const claude = claudeRecordEvents(id, record, recordIndex);
    if (claude.length > 0) return claude;
  }
  if (provider === 'gemini') {
    const gemini = geminiRecordEvents(id, record, recordIndex);
    if (gemini.length > 0) return gemini;
  }
  if (provider === 'qwen' && isQwenObservationMessage(record)) {
    const qwen = qwenRecordEvents(id, record, recordIndex);
    if (qwen.length > 0) return qwen;
  }
  return [
    ...codexExecRecordEvents(id, record, recordIndex),
    ...(isClaudeObservationMessage(record) ? claudeRecordEvents(id, record, recordIndex) : []),
    ...(isQwenObservationMessage(record) ? qwenRecordEvents(id, record, recordIndex) : []),
    ...geminiRecordEvents(id, record, recordIndex),
    ...unknownJsonRpcError(id, record, recordIndex)
  ];
}

function parsedJsonEvents(args: {
  id: string;
  provider?: NativeCliProvider | string;
  entries: JsonRecordEntry[];
}): NativeCliObservationEvent[] {
  const timeline: ParsedTimelineEntry[] = [];
  const codexMessageGroups = new Map<string, CodexMessageGroup>();
  args.entries.forEach((entry, index) => {
    const messageGroup = codexMessageGroup(entry.record);
    if (messageGroup) {
      let group = codexMessageGroups.get(messageGroup.key);
      if (!group) {
        group = { key: messageGroup.key, kind: messageGroup.kind, raw: [], rawLines: [], fragments: [] };
        codexMessageGroups.set(messageGroup.key, group);
        timeline.push({ kind: 'codex-message', key: messageGroup.key });
      }
      group.raw.push(entry.record);
      group.rawLines.push(entry.raw);
      const text = codexMessageLifecycleText(entry.record);
      if (text.fragment !== undefined) group.fragments.push(text.fragment);
      if (text.startedText !== undefined) group.startedText = text.startedText;
      if (text.completedText !== undefined) group.completedText = text.completedText;
      return;
    }
    const events = recordEvents(args.id, args.provider, entry.record, index);
    timeline.push({
      kind: 'events',
      events: events.length > 0 ? events : rawJsonObservation(args.id, entry.raw, entry.record, index)
    });
  });
  return timeline.flatMap((entry) => {
    if (entry.kind === 'events') return entry.events;
    const group = codexMessageGroups.get(entry.key);
    return group ? codexMessageGroupEvent(args.id, group) : [];
  });
}

function removeAdjacentDuplicateObservations(events: NativeCliObservationEvent[]): NativeCliObservationEvent[] {
  const out: NativeCliObservationEvent[] = [];
  for (const event of events) {
    const previous = out.at(-1);
    if (
      previous &&
      previous.role === event.role &&
      previous.source === event.source &&
      previous.text.trim() === event.text.trim()
    ) {
      // A result whose text just repeats the assistant message it settles still marks a
      // query boundary — keep it as a compact marker instead of dropping it outright.
      if (
        event.providerEventType === 'result' &&
        event.raw &&
        typeof event.raw === 'object' &&
        !Array.isArray(event.raw)
      ) {
        out.push({ ...event, text: resultMarkerText(event.raw as Record<string, unknown>) });
      }
      continue;
    }
    out.push(event);
  }
  return out;
}

function isChunkObservation(event: NativeCliObservationEvent): boolean {
  return (
    event.providerEventType?.endsWith('/delta') === true ||
    event.providerEventType?.endsWith('_delta') === true ||
    event.providerEventType?.endsWith('Delta') === true
  );
}

function rawObservationLine(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

// Streaming deltas are emitted to be concatenated verbatim: each already carries its own
// boundary whitespace (codex sends " the", " CLI"; a mid-word split sends "impl" then
// "ementation"). Guessing a space between two alphanumeric edges corrupts both cases —
// it inserts a spurious space inside a split word and, worse, between CJK characters that
// never take inter-character spaces (我来 + 先做 → "我来 先做"). Always join verbatim,
// accumulating a run's fragments and joining once so folding k deltas stays O(k).
function mergeAdjacentChunkObservations(events: NativeCliObservationEvent[]): NativeCliObservationEvent[] {
  const out: NativeCliObservationEvent[] = [];
  let runTexts: string[] = [];
  let runRaws: unknown[] = [];
  const settleRun = () => {
    if (runTexts.length < 2) return;
    const previous = out.at(-1);
    if (previous) out[out.length - 1] = { ...previous, text: runTexts.join(''), raw: runRaws.map(rawObservationLine) };
  };
  for (const event of events) {
    const previous = out.at(-1);
    if (
      previous &&
      isChunkObservation(previous) &&
      isChunkObservation(event) &&
      previous.role === event.role &&
      previous.source === event.source &&
      previous.providerEventType === event.providerEventType
    ) {
      runTexts.push(event.text);
      runRaws.push(event.raw);
      continue;
    }
    settleRun();
    out.push(event);
    runTexts = isChunkObservation(event) ? [event.text] : [];
    runRaws = isChunkObservation(event) ? [event.raw] : [];
  }
  settleRun();
  // Deltas were kept verbatim to preserve internal boundary whitespace; trim the
  // outer edges of each merged block and drop chunks that were whitespace-only.
  return out.flatMap((event) => {
    if (!isChunkObservation(event)) return [event];
    const text = event.text.trim();
    return text ? [{ ...event, text }] : [];
  });
}

function nativeCliObservationEvents(args: {
  id: string;
  provider?: NativeCliProvider | string;
  output?: string;
  observedAt?: string;
}): NativeCliObservationEvent[] | undefined {
  const text = args.output?.trim();
  if (!text) return [];
  const entries = jsonRecordEntries(text);
  if (entries.length > 0) {
    const events = removeAdjacentDuplicateObservations(
      mergeAdjacentChunkObservations(parsedJsonEvents({ id: args.id, provider: args.provider, entries }))
    );
    return args.observedAt
      ? events.map((event) => ({ ...event, createdAt: event.createdAt ?? args.observedAt }))
      : events;
  }
  return undefined;
}

export function nativeCliStreamItems(args: {
  id: string;
  provider?: NativeCliProvider | string;
  output?: string;
  observedAt?: string;
}): NativeCliObservationEvent[] {
  const text = args.output?.trim();
  if (!text) return [];
  const structured = nativeCliObservationEvents(args);
  if (structured) return structured;
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part, index) => ({
      id: `${args.id}:${index}`,
      role: part.startsWith('tool:') ? ('tool' as const) : ('agent' as const),
      text: part,
      source: 'plain-text' as const,
      createdAt: args.observedAt
    }));
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function resetLabel(value: unknown): string | undefined {
  const ms = numberValue(value);
  if (ms === undefined) return undefined;
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
}

function resetIsoLabel(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, notation: 'compact' }).format(value);
}

function tokenUsageRow(
  id: string,
  label: string,
  tokens: unknown,
  contextWindow: unknown
): NativeCliUsageLimitRow | undefined {
  const totalTokens = numberValue(tokens);
  const window = numberValue(contextWindow);
  if (totalTokens === undefined || window === undefined || window <= 0) return undefined;
  const percent = Math.max(0, Math.round((totalTokens / window) * 100));
  return {
    id,
    label,
    percent,
    meterPercent: Math.min(100, percent),
    valueLabel: `${compactNumber(totalTokens)} / ${compactNumber(window)}`
  };
}

function limitLabel(id: string, source: Record<string, unknown>): string {
  const windowMins = numberValue(source.windowDurationMins, source.window_minutes);
  if (id === 'primary' && windowMins === 300) return '5-hour limit';
  if (id === 'secondary' && windowMins === 10_080) return 'Weekly · all models';
  if (id === 'five_hour') return '5h';
  if (id === 'seven_day') return 'Weekly';
  return id.replace(/_/g, ' ');
}

function usageRow(id: string, value: unknown): NativeCliUsageLimitRow | undefined {
  const record = recordValue(value);
  if (!record) return undefined;
  const used = numberValue(record.usedPercent, record.utilization, record.used_percent);
  if (used === undefined) return undefined;
  const percent = Math.max(0, Math.min(100, Math.round(100 - used)));
  return {
    id,
    label: limitLabel(id, record),
    percent,
    resetLabel: resetLabel(record.resetsAt ?? record.resets_at)
  };
}

function usageRowsFromRecord(record: Record<string, unknown>): NativeCliUsageLimitRow[] {
  if (record.method === 'thread/tokenUsage/updated') {
    const params = recordValue(record.params);
    const tokenUsage = recordValue(params?.tokenUsage);
    const last = recordValue(tokenUsage?.last);
    const total = recordValue(tokenUsage?.total);
    const contextWindow = tokenUsage?.modelContextWindow;
    return [
      tokenUsageRow('last_turn', 'Last turn', last?.totalTokens, contextWindow),
      tokenUsageRow('thread_total', 'Thread total', total?.totalTokens, contextWindow)
    ].filter((row): row is NativeCliUsageLimitRow => !!row);
  }
  if (record.method === 'account/rateLimits/updated') {
    const params = recordValue(record.params);
    const limits = recordValue(params?.rateLimits ?? params?.rate_limits);
    return limits
      ? Object.entries(limits)
          .map(([id, value]) => usageRow(id, value))
          .filter((row): row is NativeCliUsageLimitRow => !!row)
      : [];
  }
  if (record.type === 'rate_limit_event') {
    const info = recordValue(record.rate_limit_info ?? record.rateLimitInfo);
    const id = textValue(info?.rateLimitType, info?.rate_limit_type);
    const row = id ? usageRow(id, info) : undefined;
    return row ? [row] : [];
  }
  const limits = recordValue(record.rate_limits ?? record.rateLimits);
  return limits
    ? Object.entries(limits)
        .map(([id, value]) => usageRow(id, value))
        .filter((row): row is NativeCliUsageLimitRow => !!row)
    : [];
}

function mergeUsageRows(existing: NativeCliUsageLimitRow[], next: NativeCliUsageLimitRow[]): NativeCliUsageLimitRow[] {
  const byId = new Map(existing.map((row) => [row.id, row]));
  for (const row of next) byId.set(row.id, row);
  return [...byId.values()];
}

export function nativeCliUsageLimitMeter(args: {
  output?: string;
  provider?: NativeCliProvider | string;
}): NativeCliUsageLimitMeter | null {
  const text = args.output?.trim();
  if (!text) return null;
  const rows = jsonRecordEntries(text).reduce<NativeCliUsageLimitRow[]>((acc, entry) => {
    const next = usageRowsFromRecord(entry.record);
    return next.length > 0 ? mergeUsageRows(acc, next) : acc;
  }, []);
  if (rows.length === 0) return null;
  const tokenRows = rows.filter((row) => row.id === 'last_turn' || row.id === 'thread_total');
  return { title: tokenRows.length === rows.length ? 'Token usage' : 'Usage remaining', rows };
}

export function nativeCliUsageLimitMeterFromResponse(
  usage: NativeCliUsageResponse | undefined
): NativeCliUsageLimitMeter | null {
  const rows = (usage?.records ?? []).flatMap((record) => {
    if (record.current === null || record.max === null || record.max <= 0) return [];
    const percent = Math.max(0, Math.min(100, Math.round(((record.max - record.current) / record.max) * 100)));
    return [
      {
        id: record.category,
        label: record.category.replace(/_/g, ' '),
        percent,
        resetLabel: resetIsoLabel(record.resetAt)
      }
    ];
  });
  return rows.length > 0 ? { title: 'Usage remaining', rows } : null;
}
