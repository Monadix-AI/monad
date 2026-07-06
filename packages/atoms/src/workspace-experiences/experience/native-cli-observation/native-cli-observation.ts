import type {
  NativeCliObservationEvent,
  NativeCliProvider,
  NativeCliUsageLimitMeter,
  NativeCliUsageLimitMeterRow,
  NativeCliUsageResponse
} from '@monad/protocol';
import type { NativeCliObservationJsonRecordEntry, NativeCliProviderAdapter } from '@monad/sdk-atom';

export type { NativeCliUsageLimitMeter };

type NativeCliObservationAdapter = Pick<NativeCliProviderAdapter, 'observation' | 'provider'>;
type NativeCliObservationAdapterProjection = NonNullable<NativeCliProviderAdapter['observation']>;

type ParsedTimelineEntry =
  | { kind: 'events'; events: NativeCliObservationEvent[] }
  | { kind: 'message-group'; key: string };

type NativeCliObservationAdapterResolver = (
  provider: NativeCliProvider | string | undefined
) => NativeCliObservationAdapter | undefined;

let nativeCliObservationAdapterResolver: NativeCliObservationAdapterResolver = () => undefined;

export function configureNativeCliObservationAdapterResolver(resolver: NativeCliObservationAdapterResolver): void {
  nativeCliObservationAdapterResolver = resolver;
}

function observationAdapter(args: {
  provider?: NativeCliProvider | string;
  adapter?: NativeCliObservationAdapter;
}): NativeCliObservationAdapter | undefined {
  return args.adapter ?? nativeCliObservationAdapterResolver(args.provider);
}

function observation(args: {
  id: string;
  role: NativeCliObservationEvent['role'];
  text?: string;
  source: NativeCliObservationEvent['source'];
  providerEventType?: string;
  createdAt?: string;
  raw?: unknown;
  preserveWhitespace?: boolean;
}): NativeCliObservationEvent[] {
  const text = args.preserveWhitespace ? args.text : args.text?.trim();
  if (!text) return [];
  return [
    {
      id: args.id,
      role: args.role,
      text,
      source: args.source,
      ...(args.providerEventType ? { providerEventType: args.providerEventType } : {}),
      ...(args.createdAt ? { createdAt: args.createdAt } : {}),
      ...(args.raw !== undefined ? { raw: args.raw } : {})
    }
  ];
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

function jsonRecordEntries(text: string): NativeCliObservationJsonRecordEntry[] {
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

function textValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function resultMarkerText(record: Record<string, unknown>): string {
  const subtype = textValue(record.subtype) ?? (record.is_error ? 'error' : 'completed');
  const stopReason = textValue(record.stop_reason);
  return stopReason ? `Result: ${subtype} (${stopReason})` : `Result: ${subtype}`;
}
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

function recordEvents(
  id: string,
  provider: NativeCliProvider | string | undefined,
  adapterObservation: NativeCliProviderAdapter['observation'] | undefined,
  record: Record<string, unknown>,
  recordIndex: number
): NativeCliObservationEvent[] {
  const out =
    adapterObservation?.recordProjectors.flatMap((recordProjector) => {
      if (recordProjector.supports && !recordProjector.supports(record)) return [];
      return recordProjector.parse({ id, provider, record, recordIndex });
    }) ?? [];
  return out.length > 0 ? out : unknownJsonRpcError(id, record, recordIndex);
}

function parsedJsonEvents(args: {
  id: string;
  provider?: NativeCliProvider | string;
  adapterObservation?: NativeCliProviderAdapter['observation'];
  entries: NativeCliObservationJsonRecordEntry[];
}): NativeCliObservationEvent[] {
  const timeline: ParsedTimelineEntry[] = [];
  const messageGroupProjector = args.adapterObservation?.messageGroup;
  const messageGroups = new Map<
    string,
    { projector: NonNullable<NativeCliObservationAdapterProjection['messageGroup']>; state: unknown }
  >();
  args.entries.forEach((entry, index) => {
    const messageGroup = messageGroupProjector?.create(entry.record);
    if (messageGroup && messageGroupProjector) {
      let group = messageGroups.get(messageGroup.key);
      if (!group) {
        group = { projector: messageGroupProjector, state: messageGroup.state };
        messageGroups.set(messageGroup.key, group);
        timeline.push({ kind: 'message-group', key: messageGroup.key });
      }
      group.projector.append(group.state, entry);
      return;
    }
    const events = recordEvents(args.id, args.provider, args.adapterObservation, entry.record, index);
    timeline.push({
      kind: 'events',
      events: events.length > 0 ? events : rawJsonObservation(args.id, entry.raw, entry.record, index)
    });
  });
  return timeline.flatMap((entry) => {
    if (entry.kind === 'events') return entry.events;
    const group = messageGroups.get(entry.key);
    return group ? group.projector.render(args.id, group.state) : [];
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
  adapter?: NativeCliObservationAdapter;
  output?: string;
  observedAt?: string;
  mode?: 'history' | 'live';
}): NativeCliObservationEvent[] | undefined {
  const text = args.output?.trim();
  if (!text) return [];
  const entries = jsonRecordEntries(text);
  const adapterObservation = observationAdapter(args)?.observation;
  if (entries.length > 0) {
    const projectionEntries =
      args.mode === 'history' && adapterObservation?.historyEntries
        ? adapterObservation.historyEntries(entries)
        : entries;
    return removeAdjacentDuplicateObservations(
      mergeAdjacentChunkObservations(
        parsedJsonEvents({ id: args.id, provider: args.provider, adapterObservation, entries: projectionEntries })
      )
    );
  }
  return undefined;
}

export function nativeCliStreamItems(args: {
  id: string;
  provider?: NativeCliProvider | string;
  adapter?: NativeCliObservationAdapter;
  output?: string;
  observedAt?: string;
  mode?: 'history' | 'live';
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
      source: 'plain-text' as const
    }));
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

function usageCategoryLabel(category: string): string {
  if (category === 'primary') return '5-hour limit';
  if (category === 'secondary') return 'Weekly · all models';
  if (category === 'five_hour') return '5h';
  if (category === 'seven_day') return 'Weekly';
  if (category === 'last_turn') return 'Last turn';
  if (category === 'thread_total') return 'Thread total';
  return category.replace(/_/g, ' ');
}

function usageValueLabel(category: string, current: number, max: number): string | undefined {
  if (category !== 'last_turn' && category !== 'thread_total') return undefined;
  return `${compactNumber(current)} / ${compactNumber(max)}`;
}

function usageRowsFromRecord(
  adapterObservation: NativeCliProviderAdapter['observation'] | undefined,
  record: Record<string, unknown>
): NativeCliUsageLimitMeterRow[] {
  return (adapterObservation?.usageRecords?.(record) ?? []).flatMap((usageRecord) => {
    if (usageRecord.max === undefined || usageRecord.max <= 0) return [];
    const rawPercent = Math.max(0, Math.round((usageRecord.current / usageRecord.max) * 100));
    return [
      {
        id: usageRecord.name,
        label: usageCategoryLabel(usageRecord.name),
        percent: rawPercent,
        meterPercent: Math.min(100, rawPercent),
        resetLabel: resetIsoLabel(usageRecord.resetAt),
        valueLabel: usageValueLabel(usageRecord.name, usageRecord.current, usageRecord.max)
      }
    ];
  });
}

function mergeUsageRows(
  existing: NativeCliUsageLimitMeterRow[],
  next: NativeCliUsageLimitMeterRow[]
): NativeCliUsageLimitMeterRow[] {
  const byId = new Map(existing.map((row) => [row.id, row]));
  for (const row of next) byId.set(row.id, row);
  return [...byId.values()];
}

export function nativeCliUsageLimitMeter(args: {
  output?: string;
  provider?: NativeCliProvider | string;
  adapter?: NativeCliObservationAdapter;
}): NativeCliUsageLimitMeter | null {
  const text = args.output?.trim();
  if (!text) return null;
  const adapterObservation = observationAdapter(args)?.observation;
  const rows = jsonRecordEntries(text).reduce<NativeCliUsageLimitMeterRow[]>((acc, entry) => {
    const next = usageRowsFromRecord(adapterObservation, entry.record);
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
    if (record.max === undefined || record.max <= 0) return [];
    const percent = Math.max(0, Math.round((record.current / record.max) * 100));
    return [
      {
        id: record.name,
        label: usageCategoryLabel(record.name),
        percent,
        meterPercent: Math.min(100, percent),
        resetLabel: resetIsoLabel(record.resetAt)
      }
    ];
  });
  return rows.length > 0 ? { title: 'Usage remaining', rows } : null;
}
