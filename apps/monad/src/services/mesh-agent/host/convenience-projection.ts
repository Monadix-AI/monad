import type { AgentObservationEvent, MeshConvenienceOperation } from '@monad/protocol';

/** Deterministic value comparison over a projected event. Events are plain JSON produced by the
 *  adapter projector, so a stable stringify is both sufficient and cheaper than a structural walk. */
function sameEvent(a: AgentObservationEvent, b: AgentObservationEvent): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The operations that carry a consumer from `previous` to `next`.
 *
 * The convenience plane is incremental, but the adapter projector is a pure function of the WHOLE
 * output prefix (a later raw row can still mutate an earlier event — a streaming delta coalescing
 * into one message, a tool result attaching to its call). So "what changed" cannot be read off the
 * tail; it is a diff between two projections. Because the projection is pure, the baseline for any
 * position is re-derivable from the live raw store, which is what makes a resume from an arbitrary
 * cursor correct without retaining per-connection state.
 *
 * Removals are emitted before upserts so a consumer that keys by `event.id` never briefly holds two
 * rows for one entity.
 */
export function diffObservationEvents(
  previous: AgentObservationEvent[],
  next: AgentObservationEvent[]
): MeshConvenienceOperation[] {
  const before = new Map(previous.map((event) => [event.id, event]));
  const after = new Map(next.map((event) => [event.id, event]));

  const operations: MeshConvenienceOperation[] = [];
  for (const id of before.keys()) {
    if (!after.has(id)) operations.push({ op: 'remove', eventId: id });
  }
  for (const event of next) {
    const existing = before.get(event.id);
    if (!existing || !sameEvent(existing, event)) operations.push({ op: 'upsert', event });
  }
  return operations;
}
