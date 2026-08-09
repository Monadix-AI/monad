import type {
  AgentObservationEvent,
  Event,
  MeshConvenienceFrame,
  MeshEventPageRequest,
  MeshRawEvent,
  MeshRawEventPage,
  ObservationCursor
} from '@monad/protocol';
import type { MeshAgentStreamView } from '../../../experience/types.ts';
import type { ObservationPanelEvent } from './panel-state.ts';

import { meshSessionConnectionClosedPayloadSchema, meshSessionConnectionOpenedPayloadSchema } from '@monad/protocol';

import { agentObservationCards } from '../../../../agent-adapters/observation-cards.ts';
import { type RawFrameRow, rawFrameRow } from './raw-view.ts';
import { emptyObservationTimeline, mergeConvenienceFrames, type ObservationTimeline } from './timeline-merge.ts';

// The observation panel is driven by two control notifications that carry no snapshot `revision`
// (the WS payload is `{ meshSessionId, provider, observationEpoch }`, plus `reason` on close).
// The reducer's `connectionOpened` needs a monotonic revision to stay race-free, so an `opened`
// notification is turned into a snapshot refetch (subscribe-first-then-refetch — the design's race-free
// method: the refetched snapshot carries the authoritative server revision). A `closed` notification
// already carries its epoch, so it drives the epoch-gated `connectionClosed` teardown directly.
export type ConnectionControlAction = { kind: 'refetch' } | { kind: 'dispatch'; event: ObservationPanelEvent };

export function connectionControlAction(event: Event, meshSessionId: string): ConnectionControlAction | null {
  if (event.type === 'mesh.session.connection.opened') {
    const opened = meshSessionConnectionOpenedPayloadSchema.safeParse(event.payload);
    if (!opened.success || opened.data.meshSessionId !== meshSessionId) return null;
    return { kind: 'refetch' };
  }
  if (event.type === 'mesh.session.connection.closed') {
    const closed = meshSessionConnectionClosedPayloadSchema.safeParse(event.payload);
    if (!closed.success || closed.data.meshSessionId !== meshSessionId) return null;
    return { kind: 'dispatch', event: { type: 'connectionClosed', epoch: closed.data.observationEpoch } };
  }
  return null;
}

// Live raw frames accumulate in arrival order. A reconnect resumes from `afterCursor`, but a boundary
// frame can be re-delivered — dedupe by cursor (last write wins, order preserved) so the raw plane never
// shows a duplicate row.
export function foldRawFrame(rows: RawFrameRow[], frame: MeshRawEvent): RawFrameRow[] {
  const row = rawFrameRow(frame);
  const index = rows.findIndex((existing) => existing.identity === row.identity);
  if (index === -1) return [...rows, row];
  const next = rows.slice();
  next[index] = row;
  return next;
}

// Provider-native raw events records carry no `stream` classification and their cursor is optional.
// This is presentation only — the underlying `data` is never normalized.
export function rawEventsRows(page: MeshRawEventPage): RawFrameRow[] {
  return page.records.map((record, index) => ({
    identity: record.providerIdentity ?? record.cursor ?? `${record.observedAt ?? 'events'}:${index}`,
    cursor: record.cursor ?? '',
    stream: 'unknown',
    preview: typeof record.data === 'string' ? record.data : JSON.stringify(record.data)
  }));
}

export function prependRawEventsRows(older: RawFrameRow[], current: RawFrameRow[]): RawFrameRow[] {
  const seen = new Set<string>();
  return [...older, ...current].filter((row) => {
    if (seen.has(row.identity)) return false;
    seen.add(row.identity);
    return true;
  });
}

// Fold convenience events (older) ahead of the live timeline. A provider record can project to
// multiple semantic rows (for example a tool call and its result), so `kind` keeps those rows
// distinct while `dedupeKey` still joins the same row across page and live positional ids.
function observationJoinKey(event: AgentObservationEvent): string {
  return event.dedupeKey ? `${event.dedupeKey}:${event.kind}` : event.id;
}

interface CompletedObservationTurn {
  start: number;
  end: number;
  signature: string;
}

function completedObservationTurns(events: AgentObservationEvent[], settledTail: boolean): CompletedObservationTurn[] {
  const turns: CompletedObservationTurn[] = [];
  let start: number | undefined;
  const append = (end: number) => {
    if (start === undefined) return;
    const turn = events.slice(start, end + 1);
    const userText = turn.filter((item) => item.kind === 'user-message').map((item) => item.text ?? '');
    const assistantText = turn.filter((item) => item.kind === 'assistant-message').at(-1)?.text;
    if (userText.length > 0 && assistantText) {
      turns.push({ start, end, signature: JSON.stringify([userText, assistantText]) });
    }
  };
  for (const [index, event] of events.entries()) {
    if (event.kind === 'turn-start') start = index;
    else if (event.kind === 'user-message') {
      if (start === undefined) start = index;
      else {
        const precedingAssistant = events
          .slice(start, index)
          .findLast((candidate) => candidate.kind === 'assistant-message');
        if (precedingAssistant && !precedingAssistant.streaming) {
          append(index - 1);
          start = index;
        }
      }
    }
    if (event.kind !== 'turn-end' || start === undefined) continue;
    append(index);
    start = undefined;
  }
  const tailAssistant =
    start === undefined ? undefined : events.slice(start).findLast((event) => event.kind === 'assistant-message');
  if (settledTail && start !== undefined && tailAssistant && !tailAssistant.streaming) append(events.length - 1);
  return turns;
}

function withoutSettledTurnOverlap(
  earlier: AgentObservationEvent[],
  current: AgentObservationEvent[]
): AgentObservationEvent[] {
  const earlierTurns = completedObservationTurns(earlier, true);
  const currentTurns = completedObservationTurns(current, true);
  const limit = Math.min(earlierTurns.length, currentTurns.length);
  for (let count = limit; count > 0; count -= 1) {
    const earlierStart = earlierTurns.length - count;
    const matches = Array.from(
      { length: count },
      (_, index) => earlierTurns[earlierStart + index]?.signature === currentTurns[index]?.signature
    ).every(Boolean);
    if (!matches) continue;
    const first = currentTurns[0];
    const last = currentTurns[count - 1];
    if (!first || !last) return current;
    return [...current.slice(0, first.start), ...current.slice(last.end + 1)];
  }
  return current;
}

export function foldConvenienceEvents(
  timeline: ObservationTimeline,
  earlierFrames: MeshConvenienceFrame[]
): ObservationTimeline {
  const earlier = mergeConvenienceFrames(emptyObservationTimeline, earlierFrames);
  const currentEvents = withoutSettledTurnOverlap(earlier.events, timeline.events);
  const currentByKey = new Map(currentEvents.map((event) => [observationJoinKey(event), event]));
  const seen = new Set<string>();
  const events = [...earlier.events, ...currentEvents]
    .map((event) => currentByKey.get(observationJoinKey(event)) ?? event)
    .filter((event) => {
      const key = observationJoinKey(event);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return {
    ...timeline,
    events,
    epoch: timeline.epoch ?? earlier.epoch,
    cursor: timeline.cursor ?? earlier.cursor,
    eventsBefore: timeline.eventsBefore ?? earlier.eventsBefore,
    unavailableReason: timeline.unavailableReason ?? earlier.unavailableReason
  };
}

export function convenienceEventsRequest(
  eventsBefore: ObservationCursor | null,
  limit = 20
): Omit<MeshEventPageRequest, 'view'> {
  return {
    limit,
    ...(eventsBefore ? { before: eventsBefore } : {})
  };
}

export function observationEventBootstrap(args: {
  panelOpen: boolean;
  connectionKnown: boolean;
  connected: boolean;
  eventsBefore: ObservationCursor | null;
}): { key: string; request: Omit<MeshEventPageRequest, 'view'> } | null {
  if (!args.panelOpen || !args.connectionKnown) return null;
  if (!args.connected) {
    return { key: 'disconnected:latest', request: convenienceEventsRequest(null) };
  }
  if (!args.eventsBefore) return null;
  return {
    key: `connected:${args.eventsBefore}`,
    request: convenienceEventsRequest(args.eventsBefore)
  };
}

export function observationPanelLoading(args: {
  panelOpen: boolean;
  contentAvailable: boolean;
  connectionLoading: boolean;
  connectionKnown: boolean;
  liveWaiting: boolean;
  eventsWaiting: boolean;
  eventsLoading: boolean;
}): boolean {
  return (
    args.panelOpen &&
    !args.contentAvailable &&
    (args.connectionLoading || !args.connectionKnown || args.liveWaiting || args.eventsWaiting || args.eventsLoading)
  );
}

export function observationVisiblePlane<T>(args: {
  current: T[];
  retained: T[];
  replacementPending: boolean;
  unavailable: boolean;
}): T[] {
  if (args.replacementPending && !args.unavailable) return args.retained;
  return args.current;
}

// The panel renders convenience events through the shared MeshAgentObservationPanel, which reads
// `stream.items`. Build a minimal stream view around the folded convenience events.
export function convenienceStreamView(
  base: Pick<MeshAgentStreamView, 'id' | 'agentName' | 'provider' | 'transcriptTargetId' | 'icon'>,
  events: AgentObservationEvent[],
  connected: boolean
): MeshAgentStreamView {
  const cards = agentObservationCards(events, base.provider);
  return {
    id: base.id,
    ...(base.transcriptTargetId ? { transcriptTargetId: base.transcriptTargetId } : {}),
    agentName: base.agentName,
    provider: base.provider,
    tag: 'Agent',
    ...(base.icon ? { icon: base.icon } : {}),
    status: connected ? 'running' : 'ok',
    output: '',
    items: cards
  };
}
