import type { MeshConvenienceFrame, MeshRawEvent } from '@monad/protocol';
import type {
  MeshAgentConvenienceObservationResult,
  MeshAgentRawObservationResult
} from '#/services/mesh-agent/host/observation-resolve.ts';

import { observationResume, parseObservationAfter } from '@monad/protocol';

import { MeshAgentObservationHub } from '#/services/mesh-agent/host/observation-hub.ts';

function lastRawSeq(frames: MeshRawEvent[]): number | undefined {
  return parseObservationAfter(frames.at(-1)?.cursor)?.seq;
}

function conveniencePatchSeq(frames: MeshConvenienceFrame[], epoch: string): number | undefined {
  for (const frame of [...frames].reverse()) {
    const cursor = frame.kind === 'patch' ? frame.cursor : frame.kind === 'ready' ? frame.cursor : undefined;
    const position = parseObservationAfter(cursor);
    if (position?.observationEpoch === epoch) return position.seq;
  }
  return undefined;
}

interface MeshAgentObservationSubscribeContext {
  observation: MeshAgentObservationHub;
  observeRaw(id: string, afterSeq?: number): MeshAgentRawObservationResult;
  observeConvenience(id: string, afterSeq?: number): MeshAgentConvenienceObservationResult;
}

export class MeshAgentObservationSubscribe {
  constructor(private readonly context: MeshAgentObservationSubscribeContext) {}

  /** The raw diagnostic plane over SSE: rides the observation hub's throttle/lifecycle but, on every
   *  tick, reads only the committed raw rows AFTER the last delivered cursor, so a subscriber receives
   *  each verbatim provider frame exactly once and in order (never a re-derived list). */
  subscribeRawObservation(
    id: string,
    handlers: { onFrame: (frame: MeshRawEvent) => void; onDone: () => void },
    opts?: { after?: string }
  ): { frames: MeshRawEvent[]; live: boolean; dispose: () => void } {
    const probe = this.context.observeRaw(id);
    if (probe.state !== 'live') return { frames: [], live: false, dispose: () => {} };
    // `observationResume` is the one place a stale cursor is judged, so this plane and the
    // convenience plane cannot answer the same cursor differently.
    const resume = observationResume(opts?.after, probe.observationEpoch);
    const initial = resume.kind === 'after' ? this.context.observeRaw(id, resume.seq) : probe;
    if (initial.state !== 'live') return { frames: [], live: false, dispose: () => {} };
    let lastEpoch = initial.observationEpoch;
    let lastSeq = lastRawSeq(initial.frames) ?? (resume.kind === 'after' ? resume.seq : undefined);
    const initialFrames = [...initial.frames];
    while (lastSeq !== undefined) {
      const next = this.context.observeRaw(id, lastSeq);
      if (next.state !== 'live' || next.frames.length === 0) break;
      initialFrames.push(...next.frames);
      const seq = lastRawSeq(next.frames);
      if (seq === undefined || seq === lastSeq) break;
      lastSeq = seq;
    }
    const sub = this.context.observation.subscribe(
      id,
      (signal, done) => {
        // An epoch rotation (idle resume / reconnect) restarts the row cursor from 1, so a `seq` from the
        // previous epoch would skip the new epoch's opening frames — re-read the whole epoch instead.
        const epoch = signal.state === 'live' ? signal.observationEpoch : undefined;
        const epochChanged = epoch !== undefined && epoch !== lastEpoch;
        let next = this.context.observeRaw(id, epochChanged ? undefined : lastSeq);
        while (next.state === 'live') {
          for (const frame of next.frames) handlers.onFrame(frame);
          lastEpoch = next.observationEpoch;
          const seq = lastRawSeq(next.frames);
          if (seq === undefined) {
            if (epochChanged) lastSeq = undefined;
            break;
          }
          if (seq === lastSeq) break;
          lastSeq = seq;
          next = this.context.observeRaw(id, lastSeq);
        }
        if (done) handlers.onDone();
      },
      lastSeq
    );
    if (!sub.live) return { frames: initialFrames, live: false, dispose: () => {} };
    return { frames: initialFrames, live: true, dispose: sub.dispose };
  }

  /** The convenience plane over SSE: a `ready` handshake then one atomic patch per tick carrying only
   *  what the projection actually changed since the last delivered position. On disconnect it emits a
   *  terminal `unavailable`. */
  subscribeConvenienceObservation(
    id: string,
    onFrame: (frame: MeshConvenienceFrame, done: boolean) => void,
    opts?: { after?: string }
  ): { frames: MeshConvenienceFrame[]; live: boolean; dispose: () => void } {
    const probe = this.context.observeConvenience(id);
    if (probe.state !== 'live')
      return { frames: [{ kind: 'unavailable', reason: probe.reason }], live: false, dispose: () => {} };
    const resume = observationResume(opts?.after, probe.observationEpoch);
    const initial = resume.kind === 'after' ? this.context.observeConvenience(id, resume.seq) : probe;
    if (initial.state !== 'live')
      return { frames: [{ kind: 'unavailable', reason: initial.reason }], live: false, dispose: () => {} };
    let lastEpoch = initial.observationEpoch;
    let lastSeq = conveniencePatchSeq(initial.frames, lastEpoch) ?? (resume.kind === 'after' ? resume.seq : undefined);
    const sub = this.context.observation.subscribe(
      id,
      (signal, done) => {
        // An epoch rotation restarts row sequences at 1, so a position from the previous epoch would
        // diff against the wrong baseline — re-project the new epoch from its start instead.
        const epoch = signal.state === 'live' ? signal.observationEpoch : undefined;
        const epochChanged = epoch !== undefined && epoch !== lastEpoch;
        const next = this.context.observeConvenience(id, epochChanged ? undefined : lastSeq);
        if (next.state === 'live') {
          lastEpoch = next.observationEpoch;
          lastSeq = conveniencePatchSeq(next.frames, lastEpoch) ?? lastSeq;
          for (const frame of next.frames) {
            if (frame.kind === 'patch' || (epochChanged && frame.kind === 'ready')) onFrame(frame, false);
          }
        }
        if (done) onFrame({ kind: 'unavailable', reason: `MeshAgent disconnected: ${id}` }, true);
      },
      lastSeq
    );
    if (!sub.live) return { frames: initial.frames, live: false, dispose: () => {} };
    return { frames: initial.frames, live: true, dispose: sub.dispose };
  }
}
