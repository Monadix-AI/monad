import type { MeshAgentObservationEvent, MeshAgentProvider, MeshRawEventRecord } from '@monad/protocol';
import type {
  MeshAgentEventSource,
  MeshAgentObservationJsonRecordEntry,
  MeshAgentObservationProjector,
  MeshAgentProviderEventPageContext,
  MeshAgentRuntimeHandle
} from '@monad/sdk-atom';

import { jsonRecordEntries, textValue } from './observation-projection.ts';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}

function providerRecordIds(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.flatMap(providerRecordIds);
  if (raw === null || typeof raw !== 'object') return [];
  const record = raw as Record<string, unknown>;
  const identity = typeof record.uuid === 'string' ? record.uuid : record.id;
  return typeof identity === 'string' && identity.length > 0 ? [identity] : [];
}

function projectedEventPart(id: string): string | undefined {
  return /:json:\d+:(.+)$/.exec(id)?.[1];
}

function eventDedupeKey(provider: MeshAgentProvider, event: MeshAgentObservationEvent): string {
  const rawEvents = event.provenance.rawEvents;
  const recordIds = providerRecordIds(rawEvents);
  if (recordIds.length > 0) {
    const firstRaw = rawEvents[0];
    const rawType =
      firstRaw && !Array.isArray(firstRaw) && typeof firstRaw === 'object'
        ? (firstRaw as Record<string, unknown>).type
        : undefined;
    const discriminator = [
      typeof rawType === 'string' ? rawType : undefined,
      event.role,
      event.providerEventType,
      projectedEventPart(event.id)
    ]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join(':');
    const recordIdentity = recordIds.length === 1 ? recordIds[0] : hash(recordIds.join(':'));
    return `${provider}:${recordIdentity}:${discriminator}`;
  }
  const identity = rawEvents.length === 1 ? rawEvents[0] : rawEvents;
  return `${provider}:${hash(canonicalJson(identity))}`;
}

function compactEvent(event: MeshAgentObservationEvent): MeshAgentObservationEvent {
  return Object.fromEntries(
    Object.entries(event).filter(([, value]) => value !== undefined)
  ) as MeshAgentObservationEvent;
}

function unknownEvent(args: {
  id: string;
  provider: MeshAgentProvider;
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
    ...(providerEventType ? { providerEventType } : {}),
    provenance: { rawEvents: [args.entry.record] }
  };
  return { ...event, dedupeKey: eventDedupeKey(args.provider, event) };
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
      ...event,
      dedupeKey: eventDedupeKey(args.provider, event),
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
        ...withRaw,
        dedupeKey: eventDedupeKey(args.provider, withRaw),
        projection: 'normalized' as const
      };
    });
  });
}

function plainTextEvents(provider: MeshAgentProvider, id: string, output: string): MeshAgentObservationEvent[] {
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
        provenance: { rawEvents: [text] }
      };
      return { ...event, dedupeKey: eventDedupeKey(provider, event) };
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
    merged.push({ ...next, dedupeKey: eventDedupeKey(provider, next) });
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

export function createProjectedEventSource(args: {
  provider: MeshAgentProvider;
  projection: MeshAgentObservationProjector;
  readPage?: MeshAgentEventSource['readPage'];
}): MeshAgentEventSource {
  const projectEntries = (id: string, entries: MeshAgentObservationJsonRecordEntry[]) => ({
    events: mergeStreamingEvents(
      args.provider,
      args.projection,
      projectedEntries({ id, provider: args.provider, projection: args.projection, entries })
    )
  });
  return {
    projectLive: ({ id, output, mode }) => {
      const entries = jsonRecordEntries(output);
      if (entries.length === 0) return { events: plainTextEvents(args.provider, id, output) };
      const projected =
        mode === 'events' && args.projection.eventEntries ? args.projection.eventEntries(entries) : entries;
      return projectEntries(id, projected);
    },
    createLiveProjector: ({ id }) => {
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
      let output = '';
      let carry = '';
      let recordIndex = 0;
      return {
        advance: (delta) => {
          output += delta;
          carry += delta;
          const lines = carry.split(/\r?\n/);
          carry = lines.pop() ?? '';
          for (const line of lines) {
            for (const entry of jsonRecordEntries(line)) {
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
                    ...withRaw,
                    dedupeKey: eventDedupeKey(args.provider, withRaw),
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
          }
          if (timeline.length === 0) return { events: plainTextEvents(args.provider, id, output) };
          const events = timeline.flatMap((item) =>
            item.kind === 'events' ? item.events : (groups.get(item.key)?.events ?? [])
          );
          return { events: mergeStreamingEvents(args.provider, args.projection, events) };
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
      const offset = request.before ? Number.parseInt(request.before, 10) : 0;
      const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
      if (request.view === 'convenience') {
        const events = source.projectLive({ id: context.providerSessionRef, output, mode: 'events' }).events;
        const pageEvents = events.slice(Math.max(0, events.length - start - request.limit), events.length - start);
        const hasMore = events.length - start - pageEvents.length > 0;
        return {
          state: 'available',
          view: 'convenience',
          events: pageEvents,
          ...(hasMore ? { nextCursor: String(start + pageEvents.length) } : {})
        };
      }
      const entries = jsonRecordEntries(output);
      const ordered = [...entries].reverse();
      const pageEntries = ordered.slice(start, start + request.limit);
      const records: MeshRawEventRecord[] = pageEntries.map((entry, index) => {
        const providerIdentity = providerRecordIds(entry.record)[0];
        return {
          data: entry.record,
          cursor: providerIdentity ?? `${start + index}`,
          ...(providerIdentity ? { providerIdentity } : {})
        };
      });
      const hasMore = start + pageEntries.length < ordered.length;
      return {
        state: 'available',
        view: 'raw',
        records,
        coverage: 'settled',
        ...(hasMore ? { nextCursor: String(start + pageEntries.length) } : {})
      };
    }
  };
}

export function createAppServerEventSource(args: {
  provider: MeshAgentProvider;
  projection: MeshAgentObservationProjector;
  requestPage(
    handle: MeshAgentRuntimeHandle,
    request: { before?: string; limit: number; sortDirection: 'desc'; itemsView: 'full' }
  ): string | number;
  pageOutput?(context: MeshAgentProviderEventPageContext): string | null;
  fallback?: MeshAgentEventSource;
}): MeshAgentEventSource {
  const source = createProjectedEventSource({ provider: args.provider, projection: args.projection });
  return {
    ...source,
    readPage: async (context, request) => {
      if (!context.requestProviderPage) {
        return (await args.fallback?.readPage?.(context, request)) ?? { state: 'unavailable', reason: 'unsupported' };
      }
      const page = await context.requestProviderPage((handle) =>
        args.requestPage(handle, {
          ...(request.before ? { before: request.before } : {}),
          limit: request.limit,
          sortDirection: 'desc',
          itemsView: 'full'
        })
      );
      if (request.view === 'raw') {
        const orderedItems = [...page.items].reverse();
        const records: MeshRawEventRecord[] = orderedItems.map((item, index) => {
          const providerIdentity = providerRecordIds(item)[0];
          return {
            data: item,
            cursor: providerIdentity ?? `${request.before ?? ''}:${index}`,
            ...(providerIdentity ? { providerIdentity } : {})
          };
        });
        return {
          state: 'available',
          view: 'raw',
          records,
          coverage: 'exact',
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
        };
      }
      const presentationPage = {
        ...page,
        items: [...page.items].reverse()
      };
      const output =
        args.pageOutput?.({ ...context, page: presentationPage }) ??
        presentationPage.items.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n');
      return {
        state: 'available',
        view: 'convenience',
        events: source.projectLive({ id: context.providerSessionRef, output, mode: 'events' }).events,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
      };
    }
  };
}
