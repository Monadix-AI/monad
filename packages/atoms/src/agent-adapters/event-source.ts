import type { ExternalAgentObservationEvent, ExternalAgentProvider } from '@monad/protocol';
import type {
  ExternalAgentEventSource,
  ExternalAgentObservationJsonRecordEntry,
  ExternalAgentObservationProjector,
  ExternalAgentProviderHistoryPageContext,
  ExternalAgentRuntimeHandle
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

function eventDedupeKey(provider: ExternalAgentProvider, event: ExternalAgentObservationEvent): string {
  const identity = event.raw ?? {
    role: event.role,
    text: event.text,
    providerEventType: event.providerEventType,
    createdAt: event.createdAt
  };
  return `${provider}:${hash(canonicalJson(identity))}`;
}

function compactEvent(event: ExternalAgentObservationEvent): ExternalAgentObservationEvent {
  return Object.fromEntries(
    Object.entries(event).filter(([, value]) => value !== undefined)
  ) as ExternalAgentObservationEvent;
}

function unknownEvent(args: {
  id: string;
  provider: ExternalAgentProvider;
  entry: ExternalAgentObservationJsonRecordEntry;
  recordIndex: number;
}): ExternalAgentObservationEvent {
  const providerEventType = textValue(args.entry.record.method, args.entry.record.type, args.entry.record.event);
  const event: ExternalAgentObservationEvent = {
    id: `${args.id}:unknown:${args.recordIndex}`,
    projection: 'unknown',
    role: 'system',
    text: providerEventType ?? args.entry.raw,
    source: 'unknown',
    ...(providerEventType ? { providerEventType } : {}),
    raw: args.entry.record
  };
  return { ...event, dedupeKey: eventDedupeKey(args.provider, event) };
}

function projectedRecordEvents(args: {
  id: string;
  provider: ExternalAgentProvider;
  projection: ExternalAgentObservationProjector;
  entry: ExternalAgentObservationJsonRecordEntry;
  recordIndex: number;
}): ExternalAgentObservationEvent[] {
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
  provider: ExternalAgentProvider;
  projection: ExternalAgentObservationProjector;
  entries: ExternalAgentObservationJsonRecordEntry[];
}): ExternalAgentObservationEvent[] {
  const timeline: Array<{ kind: 'events'; events: ExternalAgentObservationEvent[] } | { kind: 'group'; key: string }> =
    [];
  const groups = new Map<string, { state: unknown; entries: ExternalAgentObservationJsonRecordEntry[] }>();
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
      const raw = group.entries.map((entry) => entry.record);
      const withRaw = event.raw === undefined ? { ...event, raw } : event;
      return {
        ...withRaw,
        dedupeKey: eventDedupeKey(args.provider, withRaw),
        projection: 'normalized' as const
      };
    });
  });
}

function plainTextEvents(provider: ExternalAgentProvider, id: string, output: string): ExternalAgentObservationEvent[] {
  return output
    .split(/\n{2,}/)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text, index) => {
      const event: ExternalAgentObservationEvent = {
        id: `${id}:${index}`,
        projection: 'normalized',
        role: text.startsWith('tool:') ? 'tool' : 'agent',
        text,
        source: 'plain-text'
      };
      return { ...event, dedupeKey: eventDedupeKey(provider, event) };
    });
}

function mergeStreamingEvents(
  provider: ExternalAgentProvider,
  projection: ExternalAgentObservationProjector,
  events: ExternalAgentObservationEvent[]
): ExternalAgentObservationEvent[] {
  const merged: ExternalAgentObservationEvent[] = [];
  let run: ExternalAgentObservationEvent[] = [];
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
        raw: run.length === 1 ? first.raw : run.map((event) => event.raw)
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
  provider: ExternalAgentProvider;
  projection: ExternalAgentObservationProjector;
  readPage?: ExternalAgentEventSource['readPage'];
}): ExternalAgentEventSource {
  return {
    projectLive: ({ id, output, mode }) => {
      const entries = jsonRecordEntries(output);
      if (entries.length === 0) return { events: plainTextEvents(args.provider, id, output) };
      const projected =
        mode === 'history' && args.projection.historyEntries ? args.projection.historyEntries(entries) : entries;
      return {
        events: mergeStreamingEvents(
          args.provider,
          args.projection,
          projectedEntries({ id, provider: args.provider, projection: args.projection, entries: projected })
        )
      };
    },
    ...(args.readPage ? { readPage: args.readPage } : {})
  };
}

export function createOutputHistoryEventSource(args: {
  provider: ExternalAgentProvider;
  projection: ExternalAgentObservationProjector;
  readOutput(
    context: Parameters<NonNullable<ExternalAgentEventSource['readPage']>>[0]
  ): string | null | Promise<string | null>;
}): ExternalAgentEventSource {
  const source = createProjectedEventSource({
    provider: args.provider,
    projection: args.projection
  });
  return {
    ...source,
    readPage: async (context, request) => {
      const output = await args.readOutput(context);
      if (!output) return { state: 'unavailable', reason: 'not-found' };
      const events = source.projectLive({ id: context.providerSessionRef, output, mode: 'history' }).events;
      const offset = request.before ? Number.parseInt(request.before, 10) : 0;
      const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
      const pageEvents =
        request.sortDirection === 'desc'
          ? events.slice(Math.max(0, events.length - start - request.limit), events.length - start)
          : events.slice(start, start + request.limit);
      const hasMore =
        request.sortDirection === 'desc'
          ? events.length - start - pageEvents.length > 0
          : start + pageEvents.length < events.length;
      return {
        state: 'available',
        events: pageEvents,
        ...(hasMore ? { nextCursor: String(start + pageEvents.length) } : {})
      };
    }
  };
}

export function createAppServerHistoryEventSource(args: {
  provider: ExternalAgentProvider;
  projection: ExternalAgentObservationProjector;
  requestPage(
    handle: ExternalAgentRuntimeHandle,
    request: { before?: string; limit: number; sortDirection: 'asc' | 'desc'; itemsView: 'full' }
  ): string | number;
  pageOutput?(context: ExternalAgentProviderHistoryPageContext): string | null;
  fallback?: ExternalAgentEventSource;
}): ExternalAgentEventSource {
  const source = createProjectedEventSource({ provider: args.provider, projection: args.projection });
  return {
    ...source,
    readPage: async (context, request) => {
      if (!context.requestProviderPage) {
        return (await args.fallback?.readPage?.(context, request)) ?? { state: 'unavailable', reason: 'unsupported' };
      }
      const page = await context.requestProviderPage((handle) =>
        args.requestPage(handle, { ...request, itemsView: 'full' })
      );
      const presentationPage = {
        ...page,
        items: request.sortDirection === 'desc' ? [...page.items].reverse() : page.items
      };
      const output =
        args.pageOutput?.({ ...context, page: presentationPage }) ??
        presentationPage.items.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n');
      return {
        state: 'available',
        events: source.projectLive({ id: context.providerSessionRef, output, mode: 'history' }).events,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
      };
    }
  };
}
