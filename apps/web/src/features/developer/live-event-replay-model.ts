import type { AgentObservationEvent, LiveEventReplayFrame, MeshRawEventPage } from '@monad/protocol';

import {
  agentObservationCards,
  builtinLiveReplayAdapters,
  projectConvenienceRows
} from '@monad/atoms/live-event-replay';

export type ReplaySource = 'live' | 'history';

export function replaySource(value: string): ReplaySource | undefined {
  return value === 'live' || value === 'history' ? value : undefined;
}

export function selectReplayOption(current: string, options: string[]): string {
  if (options.length === 0) return current;
  return options.includes(current) ? current : (options[0] ?? '');
}

export interface ReplayRawFrame {
  identity: string;
  seq: number | string;
  stream?: 'stdout' | 'stderr';
  payload: unknown;
  observedAt?: string;
}

export function liveReplayFrames(frames: LiveEventReplayFrame[], observationEpoch: string): ReplayRawFrame[] {
  return frames.map((frame) => ({ ...frame, identity: `live:${observationEpoch}:${frame.seq}` }));
}

export function historyReplayFrames(page: MeshRawEventPage): ReplayRawFrame[] {
  return page.records.map((record, index) => ({
    identity: record.providerIdentity ?? record.cursor ?? `${record.observedAt ?? 'history'}:${index}`,
    seq: record.providerIdentity ?? record.cursor ?? index + 1,
    payload: record.data,
    ...(record.observedAt ? { observedAt: record.observedAt } : {})
  }));
}

// The replay tool exists to debug the PRODUCTION pipeline, so it projects through the exact shared
// path the daemon's convenience plane uses (`projectConvenienceRows`) — never a divergent fallback.
export function replayProjection(args: {
  frames: ReplayRawFrame[];
  meshSessionId: string;
  provider: string;
  source: ReplaySource;
}): { events: AgentObservationEvent[]; cards: ReturnType<typeof agentObservationCards> } {
  const adapter = builtinLiveReplayAdapters.find((candidate) => candidate.provider === args.provider);
  if (!adapter) return { events: [], cards: [] };
  const events = projectConvenienceRows(adapter, {
    id: args.meshSessionId,
    rows: args.frames.map((frame) => ({
      ...(frame.stream ? { stream: frame.stream } : {}),
      payload: replayPayloadText(frame.payload),
      ...(frame.observedAt ? { observedAt: frame.observedAt } : {})
    }))
  });
  return { events, cards: agentObservationCards(events, args.provider) };
}

function replayPayloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  return `${JSON.stringify(payload)}\n`;
}

export function formattedReplayPayload(payload: unknown): string {
  if (typeof payload !== 'string') return JSON.stringify(payload, null, 2);
  const lines = payload.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length > 1) {
    try {
      return lines.map((line) => JSON.stringify(JSON.parse(line), null, 2)).join('\n\n');
    } catch {}
  }
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload;
  }
}
