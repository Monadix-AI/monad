import type {
  AgentObservationEvent,
  Event,
  ExternalAgentConvenienceFrame,
  ExternalAgentHistoryPageRequest,
  ExternalAgentRawFrame,
  ExternalAgentRawHistoryPage
} from '@monad/protocol';
import type { ExternalAgentStreamView } from '../../../experience/types.ts';
import type { ObservationPanelEvent } from './panel-state.ts';

import {
  externalAgentSessionConnectionClosedPayloadSchema,
  externalAgentSessionConnectionOpenedPayloadSchema
} from '@monad/protocol';

import { type RawFrameRow, rawFrameRow } from './raw-view.ts';
import { mergeConvenienceFrames, type ObservationTimeline } from './timeline-merge.ts';

// The observation panel is driven by two control notifications that carry no snapshot `revision`
// (the WS payload is `{ externalAgentSessionId, provider, observationEpoch }`, plus `reason` on close).
// The reducer's `connectionOpened` needs a monotonic revision to stay race-free, so an `opened`
// notification is turned into a snapshot refetch (subscribe-first-then-refetch — the design's race-free
// method: the refetched snapshot carries the authoritative server revision). A `closed` notification
// already carries its epoch, so it drives the epoch-gated `connectionClosed` teardown directly.
export type ConnectionControlAction = { kind: 'refetch' } | { kind: 'dispatch'; event: ObservationPanelEvent };

export function connectionControlAction(event: Event, externalAgentSessionId: string): ConnectionControlAction | null {
  if (event.type === 'external_agent.session.connection.opened') {
    const opened = externalAgentSessionConnectionOpenedPayloadSchema.safeParse(event.payload);
    if (!opened.success || opened.data.externalAgentSessionId !== externalAgentSessionId) return null;
    return { kind: 'refetch' };
  }
  if (event.type === 'external_agent.session.connection.closed') {
    const closed = externalAgentSessionConnectionClosedPayloadSchema.safeParse(event.payload);
    if (!closed.success || closed.data.externalAgentSessionId !== externalAgentSessionId) return null;
    return { kind: 'dispatch', event: { type: 'connectionClosed', epoch: closed.data.observationEpoch } };
  }
  return null;
}

// Live raw frames accumulate in arrival order. A reconnect resumes from `afterCursor`, but a boundary
// frame can be re-delivered — dedupe by cursor (last write wins, order preserved) so the raw plane never
// shows a duplicate row.
export function foldRawFrame(rows: RawFrameRow[], frame: ExternalAgentRawFrame): RawFrameRow[] {
  const row = rawFrameRow(frame);
  const index = rows.findIndex((existing) => existing.cursor === row.cursor);
  if (index === -1) return [...rows, row];
  const next = rows.slice();
  next[index] = row;
  return next;
}

// Provider-native raw history records carry no `stream` classification and their cursor is optional.
// This is presentation only — the underlying `data` is never normalized.
export function rawHistoryRows(page: ExternalAgentRawHistoryPage): RawFrameRow[] {
  return page.records.map((record) => ({
    cursor: record.cursor ?? '',
    stream: 'unknown',
    preview: typeof record.data === 'string' ? record.data : JSON.stringify(record.data)
  }));
}

// Fold convenience history (older) ahead of the live timeline. `upsert` is by stable event id, so a
// later live delta updates the same row a history page already placed — history/live join is
// duplicate-free at the event boundary.
export function foldConvenienceHistory(
  timeline: ObservationTimeline,
  historyFrames: ExternalAgentConvenienceFrame[]
): ObservationTimeline {
  return mergeConvenienceFrames(timeline, historyFrames);
}

export function convenienceHistoryRequest(historyBefore: string | null, limit = 20): ExternalAgentHistoryPageRequest {
  return {
    limit,
    sortDirection: 'desc',
    itemsView: 'summary',
    ...(historyBefore ? { before: historyBefore } : {})
  };
}

// The panel renders convenience events through the shared ExternalAgentObservationPanel, which reads
// `stream.items`. Build a minimal stream view around the folded convenience events.
export function convenienceStreamView(
  base: Pick<ExternalAgentStreamView, 'id' | 'agentName' | 'provider' | 'transcriptTargetId' | 'icon'>,
  events: AgentObservationEvent[],
  connected: boolean
): ExternalAgentStreamView {
  return {
    id: base.id,
    ...(base.transcriptTargetId ? { transcriptTargetId: base.transcriptTargetId } : {}),
    agentName: base.agentName,
    provider: base.provider,
    tag: 'Agent',
    ...(base.icon ? { icon: base.icon } : {}),
    status: connected ? 'running' : 'ok',
    output: '',
    items: events
  };
}
