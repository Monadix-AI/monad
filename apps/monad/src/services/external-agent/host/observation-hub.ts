import type { ExternalAgentObservationAccessResponse } from '@monad/protocol';
import type {
  ExternalAgentObservationListener,
  LiveExternalAgentSession
} from '@/services/external-agent/host/host-types.ts';

import { OBSERVATION_THROTTLE_MS } from '@/services/external-agent/host/host-constants.ts';

interface ObservationHubContext {
  getLive(id: string): LiveExternalAgentSession | undefined;
  observe(id: string, afterSeq?: number): ExternalAgentObservationAccessResponse;
}

export class ExternalAgentObservationHub {
  private readonly listeners = new Map<string, Set<ExternalAgentObservationListener>>();
  private readonly flush = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per-session `outputSeq` already delivered to the observation stream, so the next tick emits only
   *  the delta beyond it. Seeded to the buffer position when the first listener subscribes. */
  private readonly emitted = new Map<string, number>();

  constructor(private readonly ctx: ObservationHubContext) {}

  /** Notify live observers of the current output snapshot. Non-terminal pushes are coalesced to one
   *  per OBSERVATION_THROTTLE_MS (the trailing fire reads the latest full buffer, so no update is
   *  lost); a `done` push fires immediately and cancels any pending timer. */
  publish(id: string, done = false): void {
    if (done) {
      this.clearFlush(id);
      this.emit(id, true);
      return;
    }
    if (!this.listeners.get(id)?.size) return;
    if (this.flush.has(id)) return; // an update is already scheduled; it reads the latest buffer
    this.flush.set(
      id,
      setTimeout(() => {
        this.flush.delete(id);
        this.emit(id, false);
      }, OBSERVATION_THROTTLE_MS)
    );
  }

  /** Push an observation update to live listeners. Between snapshots this sends only the delta since
   *  the last tick (`append` + cursor `seq`), not the whole 256 KB buffer — the consumer accumulates.
   *  If a listener fell so far behind that the delta is no longer wholly in the bounded tail, it falls
   *  back to a full snapshot (resync). The terminal `done` push always fires so the stream can close. */
  private emit(id: string, done: boolean): void {
    const listeners = this.listeners.get(id);
    if (!listeners?.size) return;
    const live = this.ctx.getLive(id);
    if (!live) {
      const access = this.ctx.observe(id);
      for (const listener of listeners) listener(access, done);
      if (done) {
        this.listeners.delete(id);
        this.emitted.delete(id);
      }
      return;
    }
    const emitted = this.emitted.get(id) ?? live.outputSeq;
    const deltaLen = live.outputSeq - emitted;
    if (deltaLen <= 0 && !done) return; // nothing new since the last tick
    const snapshot = live.outputBuffer.snapshot();
    const access: ExternalAgentObservationAccessResponse =
      deltaLen > 0 && deltaLen <= snapshot.length
        ? {
            state: 'live',
            externalAgentSessionId: id,
            provider: live.provider,
            append: snapshot.slice(snapshot.length - deltaLen),
            seq: live.outputSeq,
            observedAt: new Date().toISOString()
          }
        : {
            state: 'live',
            externalAgentSessionId: id,
            provider: live.provider,
            output: snapshot,
            seq: live.outputSeq,
            observedAt: new Date().toISOString()
          };
    this.emitted.set(id, live.outputSeq);
    for (const listener of listeners) listener(access, done);
    if (done) {
      this.listeners.delete(id);
      this.emitted.delete(id);
    }
  }

  private clearFlush(id: string): void {
    const timer = this.flush.get(id);
    if (timer) {
      clearTimeout(timer);
      this.flush.delete(id);
    }
  }

  subscribe(
    id: string,
    listener: ExternalAgentObservationListener,
    afterSeq?: number
  ): { access: ExternalAgentObservationAccessResponse; live: boolean; dispose: () => void } {
    const access = this.ctx.observe(id, afterSeq);
    if (access.state !== 'live') return { access, live: false, dispose: () => {} };
    let listeners = this.listeners.get(id);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(id, listeners);
      // Seed the delta cursor at this subscriber's snapshot position; a later subscriber gets a fresh
      // full snapshot and its client trims any overlap with the shared delta stream.
      this.emitted.set(id, this.ctx.getLive(id)?.outputSeq ?? 0);
    }
    listeners.add(listener);
    return {
      access,
      live: true,
      dispose: () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          this.listeners.delete(id);
          this.emitted.delete(id);
          this.clearFlush(id);
        }
      }
    };
  }
}
