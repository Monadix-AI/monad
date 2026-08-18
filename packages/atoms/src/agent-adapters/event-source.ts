import type { MeshAgentObservationEvent, MeshAgentProvider, MeshRawEventRecord } from '@monad/protocol';
import type {
  MeshAgentEventSource,
  MeshAgentObservationJsonRecordEntry,
  MeshAgentObservationProjector
} from '@monad/sdk-atom';

import { canonicalJson, contentHash } from '@monad/sdk-atom';

import { createJsonRecordStreamDecoder, jsonRecordEntries, textValue } from './observation-projection.ts';

function providerRecordIds(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.flatMap(providerRecordIds);
  if (raw === null || typeof raw !== 'object') return [];
  const record = raw as Record<string, unknown>;
  const params = recordValue(record.params);
  const nestedEvent = recordValue(params?.event);
  const identity = typeof record.uuid === 'string' ? record.uuid : (record.id ?? nestedEvent?.id);
  if (typeof identity === 'string' && identity.length > 0) return [identity];
  if (typeof identity === 'number' && Number.isFinite(identity)) return [String(identity)];
  if (typeof identity === 'bigint') return [String(identity)];
  return [];
}

export function providerRecordIdentity(raw: unknown): string | undefined {
  return providerRecordIds(raw)[0];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// A Codex rollout record carries no per-record id of its own, so the raw plane would have nothing
// stable to key a row on. The turn it belongs to plus its position inside that turn is the only
// identity the file itself exposes, and it stays stable across re-reads of the same rollout.
function outputRecordIdentities(entries: MeshAgentObservationJsonRecordEntry[]): Array<string | undefined> {
  let turnId: string | undefined;
  let turnIndex = 0;
  return entries.map((entry) => {
    const record = entry.record;
    const payload = record.payload;
    if (record.type === 'turn_context' && payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const nextTurnId = (payload as Record<string, unknown>).turn_id;
      if (typeof nextTurnId === 'string' && nextTurnId.length > 0) {
        turnId = nextTurnId;
        turnIndex = 0;
      }
    }
    if (!turnId) return providerRecordIdentity(record);
    const identity = `${turnId}:${turnIndex}`;
    turnIndex += 1;
    return identity;
  });
}

function projectedEventPart(id: string, recordIdentity: string): string | undefined {
  const recordMarker = `:json:${recordIdentity}:`;
  const markerIndex = id.indexOf(recordMarker);
  const jsonPart = markerIndex === -1 ? /:json:[^:]+:(.+)$/.exec(id)?.[1] : id.slice(markerIndex + recordMarker.length);
  if (jsonPart === 'tool-call' || jsonPart === 'tool-result') return undefined;
  if (jsonPart) return jsonPart;
  const prefix = `${recordIdentity}:`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : undefined;
}

// One provider record can project to several semantic events (a hermes assistant record carries
// `reasoning_content` AND `content`), and they all cite that same record as their raw provenance.
// The discriminator is therefore part of the identity, not decoration: without it those siblings
// collapse onto one key and the timeline renders them stacked on the same row.
function eventDedupeDiscriminator(event: MeshAgentObservationEvent, recordIdentity: string): string {
  const firstRaw = event.provenance.rawEvents[0];
  const rawType =
    firstRaw && !Array.isArray(firstRaw) && typeof firstRaw === 'object'
      ? (firstRaw as Record<string, unknown>).type
      : undefined;
  return [
    typeof rawType === 'string' ? rawType : undefined,
    event.role,
    event.providerEventType,
    projectedEventPart(event.id, recordIdentity)
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(':');
}

function eventDedupeKey(
  provider: MeshAgentProvider,
  projection: MeshAgentObservationProjector,
  event: MeshAgentObservationEvent
): string {
  const semanticIdentity = projection.dedupeIdentity?.(event);
  if (semanticIdentity) {
    const discriminator = [event.role, event.providerEventType]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join(':');
    return discriminator ? `${provider}:${semanticIdentity}:${discriminator}` : `${provider}:${semanticIdentity}`;
  }
  const rawEvents = event.provenance.rawEvents;
  // Anchor identity on the FIRST raw record, never on the whole set. A coalesced event (a streaming
  // run, a message group) absorbs one more record per delta, so a set-derived identity changes on
  // every token: the consumer keys a new row, remounts it, and anything the row was measuring — an
  // elapsed-time readout, a scroll position, a disclosure — restarts. The first record is also the
  // one both planes agree on, so a partially-streamed live run still joins its earlier-events twin.
  const firstRaw = rawEvents[0];
  const recordIdentity = providerRecordIdentity(firstRaw) ?? contentHash(canonicalJson(firstRaw ?? null));
  const discriminator = eventDedupeDiscriminator(event, recordIdentity);
  return discriminator ? `${provider}:${recordIdentity}:${discriminator}` : `${provider}:${recordIdentity}`;
}

function compactEvent(event: MeshAgentObservationEvent): MeshAgentObservationEvent {
  return Object.fromEntries(
    Object.entries(event).filter(([, value]) => value !== undefined)
  ) as MeshAgentObservationEvent;
}

function withObservedAt(event: MeshAgentObservationEvent, observedAt: string | undefined): MeshAgentObservationEvent {
  return event.createdAt || !observedAt ? event : { ...event, createdAt: observedAt };
}

function unknownEvent(args: {
  id: string;
  provider: MeshAgentProvider;
  projection: MeshAgentObservationProjector;
  entry: MeshAgentObservationJsonRecordEntry;
  recordIndex: number;
}): MeshAgentObservationEvent {
  const providerEventType = textValue(args.entry.record.method, args.entry.record.type, args.entry.record.event);
  const event: MeshAgentObservationEvent = {
    id: `${args.id}:unknown:${args.recordIndex}`,
    projection: 'unknown',
    role: 'system',
    text: providerEventType ?? args.entry.raw,
    source: 'unknown',
    ...(args.entry.observedAt ? { createdAt: args.entry.observedAt } : {}),
    ...(providerEventType ? { providerEventType } : {}),
    provenance: { rawEvents: [args.entry.record] }
  };
  return { ...event, dedupeKey: eventDedupeKey(args.provider, args.projection, event) };
}

function projectedRecordEvents(args: {
  id: string;
  provider: MeshAgentProvider;
  projection: MeshAgentObservationProjector;
  entry: MeshAgentObservationJsonRecordEntry;
  recordIndex: number;
}): MeshAgentObservationEvent[] {
  const events = args.projection.recordProjectors.flatMap((projector) => {
    if (projector.supports && !projector.supports(args.entry.record)) return [];
    return projector.parse({
      id: args.id,
      provider: args.provider,
      record: args.entry.record,
      recordIndex: args.recordIndex
    });
  });
  if (events.length === 0) return [unknownEvent(args)];
  return events.map((event) =>
    compactEvent({
      ...withObservedAt(event, args.entry.observedAt),
      dedupeKey: eventDedupeKey(args.provider, args.projection, event),
      projection: 'normalized' as const
    })
  );
}

function projectedEntries(args: {
  id: string;
  provider: MeshAgentProvider;
  projection: MeshAgentObservationProjector;
  entries: MeshAgentObservationJsonRecordEntry[];
}): MeshAgentObservationEvent[] {
  const timeline: Array<{ kind: 'events'; events: MeshAgentObservationEvent[] } | { kind: 'group'; key: string }> = [];
  const groups = new Map<string, { state: unknown; entries: MeshAgentObservationJsonRecordEntry[] }>();
  const groupProjector = args.projection.messageGroup;

  args.entries.forEach((entry, recordIndex) => {
    const created = groupProjector?.create(entry.record);
    if (created && groupProjector) {
      let group = groups.get(created.key);
      if (!group) {
        group = { state: created.state, entries: [] };
        groups.set(created.key, group);
        timeline.push({ kind: 'group', key: created.key });
      }
      group.entries.push(entry);
      groupProjector.append(group.state, entry);
      return;
    }
    timeline.push({ kind: 'events', events: projectedRecordEvents({ ...args, entry, recordIndex }) });
  });

  return timeline.flatMap((item) => {
    if (item.kind === 'events') return item.events;
    const group = groups.get(item.key);
    if (!group || !groupProjector) return [];
    return groupProjector.render(args.id, group.state).map((event) => {
      const rawEvents = group.entries.map((entry) => entry.record);
      const withRaw = event.provenance.rawEvents.length === 0 ? { ...event, provenance: { rawEvents } } : event;
      return {
        ...withObservedAt(withRaw, group.entries.at(-1)?.observedAt),
        dedupeKey: eventDedupeKey(args.provider, args.projection, withRaw),
        projection: 'normalized' as const
      };
    });
  });
}

function plainTextEvents(
  provider: MeshAgentProvider,
  projection: MeshAgentObservationProjector,
  id: string,
  output: string,
  observedAt?: string
): MeshAgentObservationEvent[] {
  return output
    .split(/\n{2,}/)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text, index) => {
      const event: MeshAgentObservationEvent = {
        id: `${id}:${index}`,
        projection: 'normalized',
        role: text.startsWith('tool:') ? 'tool' : 'agent',
        text,
        source: 'plain-text',
        ...(observedAt ? { createdAt: observedAt } : {}),
        provenance: { rawEvents: [text] }
      };
      return { ...event, dedupeKey: eventDedupeKey(provider, projection, event) };
    });
}

function mergeStreamingEvents(
  provider: MeshAgentProvider,
  projection: MeshAgentObservationProjector,
  events: MeshAgentObservationEvent[]
): MeshAgentObservationEvent[] {
  const merged: MeshAgentObservationEvent[] = [];
  let run: MeshAgentObservationEvent[] = [];
  const settle = () => {
    if (run.length === 0) return;
    const first = run[0];
    if (!first) return;
    const custom = run.length > 1 ? projection.mergeStreamingRun?.(run) : undefined;
    const next =
      custom ??
      compactEvent({
        ...first,
        text: run.map((event) => event.text).join(''),
        provenance: { rawEvents: run.flatMap((event) => event.provenance.rawEvents) }
      });
    merged.push({ ...next, dedupeKey: eventDedupeKey(provider, projection, next) });
    run = [];
  };
  for (const event of events) {
    const first = run[0];
    const streaming = projection.isStreamingFragment?.(event) ?? false;
    const sameRun =
      first &&
      projection.isStreamingFragment?.(first) &&
      first.role === event.role &&
      first.source === event.source &&
      first.providerEventType === event.providerEventType;
    if (!streaming || (first && !sameRun)) settle();
    if (streaming) run.push(event);
    else merged.push(event);
  }
  settle();
  return merged;
}

function finalizeEvents(
  provider: MeshAgentProvider,
  projection: MeshAgentObservationProjector,
  events: MeshAgentObservationEvent[]
): MeshAgentObservationEvent[] {
  const merged = mergeStreamingEvents(provider, projection, events);
  const reconciled = projection.reconcileEvents?.(merged) ?? merged;
  return reconciled.map((event) =>
    compactEvent({
      ...event,
      dedupeKey: eventDedupeKey(provider, projection, event)
    })
  );
}

export function createProjectedEventSource(args: {
  provider: MeshAgentProvider;
  projection: MeshAgentObservationProjector;
  readPage?: MeshAgentEventSource['readPage'];
}): MeshAgentEventSource {
  const projectEntries = (id: string, entries: MeshAgentObservationJsonRecordEntry[]) => ({
    events: finalizeEvents(
      args.provider,
      args.projection,
      projectedEntries({
        id,
        provider: args.provider,
        projection: args.projection,
        entries
      })
    )
  });
  return {
    projectLive: ({ id, output, observedAt, providerSessionRef }) => {
      const entries = jsonRecordEntries(output).map((entry) => ({ ...entry, observedAt }));
      if (entries.length === 0)
        return { events: plainTextEvents(args.provider, args.projection, id, output, observedAt) };
      const projected = args.projection.eventEntries?.(entries, { providerSessionRef }) ?? entries;
      return projectEntries(id, projected);
    },
    createLiveProjector: ({ id, providerSessionRef }) => {
      const timeline: Array<{ kind: 'events'; events: MeshAgentObservationEvent[] } | { kind: 'group'; key: string }> =
        [];
      const groups = new Map<
        string,
        {
          state: unknown;
          entries: MeshAgentObservationJsonRecordEntry[];
          events: MeshAgentObservationEvent[];
        }
      >();
      const groupProjector = args.projection.messageGroup;
      const decoder = createJsonRecordStreamDecoder();
      let output = '';
      let recordIndex = 0;
      return {
        advance: (delta, observedAt) => {
          output += delta;
          const decoded = decoder.push(delta).map((entry) => ({ ...entry, observedAt }));
          const entries = args.projection.eventEntries?.(decoded, { providerSessionRef }) ?? decoded;
          for (const entry of entries) {
            const created = groupProjector?.create(entry.record);
            if (created && groupProjector) {
              let group = groups.get(created.key);
              if (!group) {
                group = { state: created.state, entries: [], events: [] };
                groups.set(created.key, group);
                timeline.push({ kind: 'group', key: created.key });
              }
              group.entries.push(entry);
              groupProjector.append(group.state, entry);
              group.events = groupProjector.render(id, group.state).map((event) => {
                const rawEvents = group.entries.map((item) => item.record);
                const withRaw =
                  event.provenance.rawEvents.length === 0 ? { ...event, provenance: { rawEvents } } : event;
                return {
                  ...withObservedAt(withRaw, group.entries.at(-1)?.observedAt),
                  dedupeKey: eventDedupeKey(args.provider, args.projection, withRaw),
                  projection: 'normalized' as const
                };
              });
            } else {
              timeline.push({
                kind: 'events',
                events: projectedRecordEvents({
                  id,
                  provider: args.provider,
                  projection: args.projection,
                  entry,
                  recordIndex
                })
              });
            }
            recordIndex += 1;
          }
          if (timeline.length === 0)
            return { events: plainTextEvents(args.provider, args.projection, id, output, observedAt) };
          const events = timeline.flatMap((item) =>
            item.kind === 'events' ? item.events : (groups.get(item.key)?.events ?? [])
          );
          return { events: finalizeEvents(args.provider, args.projection, events) };
        }
      };
    },
    ...(args.readPage ? { readPage: args.readPage } : {})
  };
}

export function createOutputEventSource(args: {
  provider: MeshAgentProvider;
  projection: MeshAgentObservationProjector;
  readOutput(
    context: Parameters<NonNullable<MeshAgentEventSource['readPage']>>[0]
  ): string | null | Promise<string | null>;
}): MeshAgentEventSource {
  const source = createProjectedEventSource({
    provider: args.provider,
    projection: args.projection
  });
  return {
    ...source,
    readPage: async (context, request) => {
      const output = await args.readOutput(context);
      if (!output) return { state: 'unavailable', reason: 'not-found' };
      if (request.view === 'convenience') {
        const events = source.projectLive({ id: context.providerSessionRef, output, mode: 'events' }).events;
        const range = linePageRange(events.length, request.before, request.limit);
        const pageEvents = events.slice(range.start, range.end);
        return {
          state: 'available',
          view: 'convenience',
          events: pageEvents,
          ...(range.nextCursor ? { nextCursor: range.nextCursor } : {})
        };
      }
      const entries = jsonRecordEntries(output);
      const identities = outputRecordIdentities(entries);
      const ordered = entries.map((entry, index) => ({ entry, providerIdentity: identities[index] }));
      const range = linePageRange(ordered.length, request.before, request.limit);
      const pageEntries = ordered.slice(range.start, range.end);
      const records: MeshRawEventRecord[] = pageEntries.map(({ entry, providerIdentity }, index) => {
        return {
          data: entry.record,
          cursor: providerIdentity ?? `${range.start + index}`,
          ...(providerIdentity ? { providerIdentity } : {})
        };
      });
      return {
        state: 'available',
        view: 'raw',
        records,
        coverage: 'settled',
        ...(range.nextCursor ? { nextCursor: range.nextCursor } : {})
      };
    }
  };
}

function linePageRange(total: number, before: string | undefined, limit: number) {
  const match = before?.match(/^line:(\d+)$/);
  const parsed = match?.[1] ? Number.parseInt(match[1], 10) : total;
  const end = Number.isSafeInteger(parsed) ? Math.min(total, Math.max(0, parsed)) : total;
  const start = Math.max(0, end - limit);
  return { start, end, ...(start > 0 ? { nextCursor: `line:${start}` } : {}) };
}
