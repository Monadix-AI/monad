import type {
  AgentObservationEvent,
  MeshAgentObservationEvent,
  MeshAgentProvider,
  MeshAgentUsageLimitMeter,
  MeshAgentUsageLimitMeterRow,
  MeshAgentUsageResponse
} from '@monad/protocol';
import type {
  MeshAgentObservationActivity,
  MeshAgentObservationJsonRecordEntry,
  MeshAgentProviderAdapter
} from '@monad/sdk-atom';

import { toAgentObservationEvent } from '../../../agent-adapters/neutral-observation.ts';

export type { MeshAgentUsageLimitMeter };

type MeshAgentObservationAdapter = Pick<MeshAgentProviderAdapter, 'observation' | 'provider'>;
type MeshAgentObservationAdapterProjection = NonNullable<MeshAgentProviderAdapter['observation']>;

type ParsedTimelineEntry =
  | { kind: 'events'; events: MeshAgentObservationEvent[] }
  | { kind: 'message-group'; key: string };

type MeshAgentObservationAdapterResolver = (
  provider: MeshAgentProvider | string | undefined
) => MeshAgentObservationAdapter | undefined;

let meshAgentObservationAdapterResolver: MeshAgentObservationAdapterResolver = () => undefined;

export function configureMeshAgentObservationAdapterResolver(resolver: MeshAgentObservationAdapterResolver): void {
  meshAgentObservationAdapterResolver = resolver;
}

function observationAdapter(args: {
  provider?: MeshAgentProvider | string;
  adapter?: MeshAgentObservationAdapter;
}): MeshAgentObservationAdapter | undefined {
  return args.adapter ?? meshAgentObservationAdapterResolver(args.provider);
}

function observation(args: {
  id: string;
  role: MeshAgentObservationEvent['role'];
  text?: string;
  source: MeshAgentObservationEvent['source'];
  providerEventType?: string;
  createdAt?: string;
  raw?: unknown;
  rawEvents?: unknown[];
  preserveWhitespace?: boolean;
}): MeshAgentObservationEvent[] {
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
      provenance: { rawEvents: args.rawEvents ?? [args.raw] }
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

function jsonRecordEntries(text: string): MeshAgentObservationJsonRecordEntry[] {
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

function textValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function rawJsonObservation(
  id: string,
  rawLine: string,
  record: Record<string, unknown>,
  recordIndex: number
): MeshAgentObservationEvent[] {
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
): MeshAgentObservationEvent[] {
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
  provider: MeshAgentProvider | string | undefined,
  adapterObservation: MeshAgentProviderAdapter['observation'] | undefined,
  record: Record<string, unknown>,
  recordIndex: number
): MeshAgentObservationEvent[] {
  const out =
    adapterObservation?.recordProjectors.flatMap((recordProjector) => {
      if (recordProjector.supports && !recordProjector.supports(record)) return [];
      return recordProjector.parse({ id, provider, record, recordIndex });
    }) ?? [];
  return out.length > 0 ? out : unknownJsonRpcError(id, record, recordIndex);
}

function parsedJsonEvents(args: {
  id: string;
  provider?: MeshAgentProvider | string;
  adapterObservation?: MeshAgentProviderAdapter['observation'];
  entries: MeshAgentObservationJsonRecordEntry[];
}): MeshAgentObservationEvent[] {
  const timeline: ParsedTimelineEntry[] = [];
  const messageGroupProjector = args.adapterObservation?.messageGroup;
  const messageGroups = new Map<
    string,
    { projector: NonNullable<MeshAgentObservationAdapterProjection['messageGroup']>; state: unknown }
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

// Streaming deltas are emitted to be concatenated verbatim: each already carries its own
// boundary whitespace (codex sends " the", " CLI"; a mid-word split sends "impl" then
// "ementation"). Guessing a space between two alphanumeric edges corrupts both cases —
// it inserts a spurious space inside a split word and, worse, between CJK characters that
// never take inter-character spaces (我来 + 先做 → "我来 先做"). Always join verbatim,
// accumulating a run's fragments and joining once so folding k deltas stays O(k).
function mergeAdjacentChunkObservations(
  events: MeshAgentObservationEvent[],
  adapterObservation: MeshAgentObservationAdapterProjection | undefined
): MeshAgentObservationEvent[] {
  // "Is this a streaming fragment?" is the adapter's call (its delta event names), not a suffix check
  // here. No adapter (plain text) → nothing is a fragment.
  const isChunkObservation = (event: MeshAgentObservationEvent): boolean =>
    adapterObservation?.isStreamingFragment?.(event) ?? false;
  const out: MeshAgentObservationEvent[] = [];
  let runEvents: MeshAgentObservationEvent[] = [];
  let runTexts: string[] = [];
  let runRaws: unknown[] = [];
  const settleRun = () => {
    if (runTexts.length < 2) return;
    const previous = out.at(-1);
    if (!previous) return;
    out[out.length - 1] = adapterObservation?.mergeStreamingRun?.(runEvents) ?? {
      ...previous,
      text: runTexts.join(''),
      provenance: { rawEvents: runRaws }
    };
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
      runRaws.push(...event.provenance.rawEvents);
      runEvents.push(event);
      continue;
    }
    settleRun();
    out.push(event);
    runTexts = isChunkObservation(event) ? [event.text] : [];
    runRaws = isChunkObservation(event) ? [...event.provenance.rawEvents] : [];
    runEvents = isChunkObservation(event) ? [event] : [];
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

function keepFirstObservationByProviderEventId(events: MeshAgentObservationEvent[]): MeshAgentObservationEvent[] {
  const seen = new Set<string>();
  const observations: MeshAgentObservationEvent[] = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    observations.push(event);
  }
  return observations;
}

function meshAgentObservationEvents(args: {
  id: string;
  provider?: MeshAgentProvider | string;
  adapter?: MeshAgentObservationAdapter;
  output?: string;
  observedAt?: string;
  mode?: 'events' | 'live';
}): MeshAgentObservationEvent[] | undefined {
  const text = args.output?.trim();
  if (!text) return [];
  const entries = jsonRecordEntries(text);
  const adapterObservation = observationAdapter(args)?.observation;
  if (entries.length > 0) {
    const projectionEntries =
      args.mode === 'events' && adapterObservation?.eventEntries ? adapterObservation.eventEntries(entries) : entries;
    return keepFirstObservationByProviderEventId(
      mergeAdjacentChunkObservations(
        parsedJsonEvents({ id: args.id, provider: args.provider, adapterObservation, entries: projectionEntries }),
        adapterObservation
      )
    );
  }
  if (
    adapterObservation &&
    text.length >= 64 * 1024 &&
    (text.includes('"method":') || text.includes('\\"method\\":') || text.includes('"type":'))
  )
    return [];
  return undefined;
}

export function meshAgentStreamItems(args: {
  id: string;
  provider?: MeshAgentProvider | string;
  adapter?: MeshAgentObservationAdapter;
  output?: string;
  observedAt?: string;
  mode?: 'events' | 'live';
}): MeshAgentObservationEvent[] {
  const text = args.output?.trim();
  if (!text) return [];
  const structured = meshAgentObservationEvents(args);
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
      provenance: { rawEvents: [part] }
    }));
}

export function meshAgentObservationIdentity(args: {
  adapter?: MeshAgentObservationAdapter;
  event: MeshAgentObservationEvent;
  provider?: MeshAgentProvider | string;
}): string | undefined {
  return observationAdapter(args)?.observation?.identity?.(args.event);
}

export function meshAgentObservationCheckpoint(args: {
  adapter?: MeshAgentObservationAdapter;
  event: MeshAgentObservationEvent;
  provider?: MeshAgentProvider | string;
}): string | undefined {
  return observationAdapter(args)?.observation?.checkpoint?.(args.event);
}

/** Neutral projection of the full output: the same records `meshAgentStreamItems` produces, mapped
 *  to `AgentObservationEvent` via the adapter's own classification. Re-run on the full snapshot every
 *  frame (server side) so a consumer replaces its list wholesale — no client-side delta re-derivation. */
export function meshAgentNeutralStreamItems(args: {
  id: string;
  provider?: MeshAgentProvider | string;
  adapter?: MeshAgentObservationAdapter;
  output?: string;
  observedAt?: string;
  mode?: 'events' | 'live';
}): AgentObservationEvent[] {
  const projector = args.adapter?.observation;
  return meshAgentStreamItems(args)
    .map((event) => toAgentObservationEvent(event, projector))
    .filter((event): event is AgentObservationEvent => event !== null);
}

/** Structured (JSON-record) events only — `undefined` when the output has no structured records (pure
 *  plain text), so a caller can distinguish "not generating" from "can't tell". */
export function meshAgentStructuredEvents(args: {
  id: string;
  provider?: MeshAgentProvider | string;
  adapter?: MeshAgentObservationAdapter;
  output?: string;
  observedAt?: string;
  mode?: 'events' | 'live';
}): MeshAgentObservationEvent[] | undefined {
  return meshAgentObservationEvents(args);
}

function roleFallbackActivity(event: MeshAgentObservationEvent): MeshAgentObservationActivity | undefined {
  if (event.role === 'tool') return 'tool-call';
  if (event.role === 'user') return 'user';
  if (event.role === 'system') return 'system';
  return 'message';
}

/** Provider-agnostic activity kind for one event: the owning adapter classifies it (its vocabulary
 *  lives there); a role-only fallback covers plain-text / an adapter without a classifier. */
export function classifyMeshAgentActivity(
  event: MeshAgentObservationEvent,
  opts: { provider?: MeshAgentProvider | string; adapter?: MeshAgentObservationAdapter } = {}
): MeshAgentObservationActivity | undefined {
  const classify = observationAdapter(opts)?.observation?.classifyActivity;
  return classify?.(event) ?? roleFallbackActivity(event);
}

/** Whether the events show a turn in flight: any content activity turns it on, a `turn-end` marker
 *  turns it off, and the final state wins. Generic over providers — the per-event kind comes from the
 *  adapter, not from provider event strings in this consumer. */
export function meshAgentEventsAreGenerating(
  events: readonly MeshAgentObservationEvent[],
  opts: { provider?: MeshAgentProvider | string; adapter?: MeshAgentObservationAdapter } = {}
): boolean {
  let active = false;
  for (const event of events) {
    const kind = classifyMeshAgentActivity(event, opts);
    // `turn-end` settles the turn; agent output (message/thinking/tool/system-turn-start) means it is
    // in flight. A `user` event is neutral: a lone input message is not the agent generating, but a
    // mid-turn tool-result (also role `user`) must not clear an in-flight turn — so it changes nothing.
    if (kind === 'turn-end') active = false;
    else if (kind !== undefined && kind !== 'user') active = true;
  }
  return active;
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
  adapterObservation: MeshAgentProviderAdapter['observation'] | undefined,
  record: Record<string, unknown>
): MeshAgentUsageLimitMeterRow[] {
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
  existing: MeshAgentUsageLimitMeterRow[],
  next: MeshAgentUsageLimitMeterRow[]
): MeshAgentUsageLimitMeterRow[] {
  const byId = new Map(existing.map((row) => [row.id, row]));
  for (const row of next) byId.set(row.id, row);
  return [...byId.values()];
}

export function meshAgentUsageLimitMeter(args: {
  output?: string;
  provider?: MeshAgentProvider | string;
  adapter?: MeshAgentObservationAdapter;
}): MeshAgentUsageLimitMeter | null {
  const text = args.output?.trim();
  if (!text) return null;
  const adapterObservation = observationAdapter(args)?.observation;
  const rows = jsonRecordEntries(text).reduce<MeshAgentUsageLimitMeterRow[]>((acc, entry) => {
    const next = usageRowsFromRecord(adapterObservation, entry.record);
    return next.length > 0 ? mergeUsageRows(acc, next) : acc;
  }, []);
  if (rows.length === 0) return null;
  const tokenRows = rows.filter((row) => row.id === 'last_turn' || row.id === 'thread_total');
  return { title: tokenRows.length === rows.length ? 'Token usage' : 'Usage remaining', rows };
}

export function meshAgentUsageLimitMeterFromResponse(
  usage: MeshAgentUsageResponse | undefined
): MeshAgentUsageLimitMeter | null {
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
