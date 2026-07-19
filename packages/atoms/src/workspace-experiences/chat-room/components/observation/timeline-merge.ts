import type { AgentObservationEvent, MeshConvenienceFrame, ObservationCursor } from '@monad/protocol';

export interface ObservationTimeline {
  events: AgentObservationEvent[];
  epoch: string | null;
  /** The last delivered position; the resume anchor handed back on reconnect. Never a row key. */
  cursor: ObservationCursor | null;
  eventsBefore: ObservationCursor | null;
  unavailableReason: string | null;
}

export const emptyObservationTimeline: ObservationTimeline = {
  events: [],
  epoch: null,
  cursor: null,
  eventsBefore: null,
  unavailableReason: null
};

// Fold one convenience frame into the timeline. A `patch` carries every operation for one raw
// position and is applied against a SINGLE working copy: folding its operations one at a time would
// allocate a fresh event array (and, through a state setter, force a React commit) per operation,
// re-introducing the per-operation cost the wire contract exists to remove.
//
// `upsert` replaces by stable event id in place, so a events/live join or a streaming delta updates
// the same row instead of duplicating it; `remove` retracts by id; `ready` records the epoch,
// boundary, and resume anchor; `unavailable` records the reason but never discards rendered events.
export function mergeConvenienceFrame(timeline: ObservationTimeline, frame: MeshConvenienceFrame): ObservationTimeline {
  switch (frame.kind) {
    case 'ready':
      return {
        ...timeline,
        ...(timeline.epoch !== null && timeline.epoch !== frame.observationEpoch ? { events: [] } : {}),
        epoch: frame.observationEpoch ?? null,
        cursor: frame.cursor ?? null,
        eventsBefore: frame.eventsBefore ?? null,
        unavailableReason: null
      };
    case 'unavailable':
      return { ...timeline, unavailableReason: frame.reason };
    case 'patch': {
      const events = timeline.events.slice();
      const indexById = new Map(events.map((event, index) => [event.id, index]));
      for (const operation of frame.operations) {
        if (operation.op === 'remove') {
          const index = indexById.get(operation.eventId);
          if (index === undefined) continue;
          events.splice(index, 1);
          indexById.clear();
          for (const [position, event] of events.entries()) indexById.set(event.id, position);
          continue;
        }
        const index = indexById.get(operation.event.id);
        if (index === undefined) {
          indexById.set(operation.event.id, events.length);
          events.push(operation.event);
          continue;
        }
        events[index] = operation.event;
      }
      // `cursor` advances the consumption position only — row identity stays `event.id`, which is
      // what the virtualized list keys on.
      return { ...timeline, events, cursor: frame.cursor };
    }
  }
}

export function mergeConvenienceFrames(
  timeline: ObservationTimeline,
  frames: MeshConvenienceFrame[]
): ObservationTimeline {
  return frames.reduce(mergeConvenienceFrame, timeline);
}
