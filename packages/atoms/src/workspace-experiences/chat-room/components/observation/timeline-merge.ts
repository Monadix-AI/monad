import type { AgentObservationEvent, ExternalAgentConvenienceFrame } from '@monad/protocol';

export interface ObservationTimeline {
  events: AgentObservationEvent[];
  epoch: string | null;
  historyBefore: string | null;
  unavailableReason: string | null;
}

export const emptyObservationTimeline: ObservationTimeline = {
  events: [],
  epoch: null,
  historyBefore: null,
  unavailableReason: null
};

// Fold one convenience frame into the timeline. `upsert` replaces by stable event id (in place, so a
// history/live join or a streaming delta updates the same row instead of duplicating it); `remove`
// retracts by id; `ready` records the epoch/boundary; `unavailable` records the reason but never
// discards already-rendered events.
export function mergeConvenienceFrame(
  timeline: ObservationTimeline,
  frame: ExternalAgentConvenienceFrame
): ObservationTimeline {
  switch (frame.kind) {
    case 'ready':
      return {
        ...timeline,
        epoch: frame.observationEpoch ?? null,
        historyBefore: frame.historyBefore ?? null,
        unavailableReason: null
      };
    case 'unavailable':
      return { ...timeline, unavailableReason: frame.reason };
    case 'remove':
      return { ...timeline, events: timeline.events.filter((event) => event.id !== frame.eventId) };
    case 'upsert': {
      const index = timeline.events.findIndex((event) => event.id === frame.event.id);
      if (index === -1) return { ...timeline, events: [...timeline.events, frame.event] };
      const events = timeline.events.slice();
      events[index] = frame.event;
      return { ...timeline, events };
    }
  }
}

export function mergeConvenienceFrames(
  timeline: ObservationTimeline,
  frames: ExternalAgentConvenienceFrame[]
): ObservationTimeline {
  return frames.reduce(mergeConvenienceFrame, timeline);
}
