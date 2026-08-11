import type { AgentObservationEvent, LiveEventReplayFrame, MeshRawEventPage } from '@monad/protocol';

import {
  agentObservationCards,
  builtinMeshAgentObservationAdapters,
  meshAgentNeutralStreamItems
} from '@monad/atoms/live-event-replay';

export type ReplaySource = 'live' | 'history';

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

export function replayProjection(args: {
  frames: ReplayRawFrame[];
  meshSessionId: string;
  provider: string;
  source: ReplaySource;
}): { events: AgentObservationEvent[]; cards: ReturnType<typeof agentObservationCards> } {
  const adapter = builtinMeshAgentObservationAdapters.find((candidate) => candidate.provider === args.provider);
  if (!adapter?.observation) return { events: [], cards: [] };
  const stdout = args.frames.filter((frame) => frame.stream !== 'stderr');
  const events = meshAgentNeutralStreamItems({
    id: args.meshSessionId,
    provider: args.provider,
    adapter,
    output: stdout.map((frame) => replayPayloadText(frame.payload)).join(''),
    observedAt: stdout.at(-1)?.observedAt,
    mode: args.source === 'live' ? 'live' : 'events'
  });
  return { events, cards: agentObservationCards(events, args.provider) };
}

export function replayPayloadText(payload: unknown): string {
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
