import type { ExternalAgentObservationAccessResponse } from '@monad/protocol';
import type {
  ExternalAgentObservationListener,
  LiveExternalAgentSession
} from '#/services/external-agent/host/host-types.ts';

import { OBSERVATION_THROTTLE_MS } from '#/services/external-agent/host/host-constants.ts';

interface ObservationHubContext {
  getLive(id: string): LiveExternalAgentSession | undefined;
  observe(id: string, afterSeq?: number): ExternalAgentObservationAccessResponse;
}

export class ExternalAgentObservationHub {
  private readonly listeners = new Map<string, Set<ExternalAgentObservationListener>>();
  private readonly flush = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly emitted = new Map<string, { epoch: string; seq: number }>();

  constructor(private readonly ctx: ObservationHubContext) {}

  publish(id: string, done = false): void {
    if (done) {
      this.clearFlush(id);
      this.emit(id, true);
      return;
    }
    if (!this.listeners.get(id)?.size) return;
    if (this.flush.has(id)) return;
    this.flush.set(
      id,
      setTimeout(() => {
        this.flush.delete(id);
        this.emit(id, false);
      }, OBSERVATION_THROTTLE_MS)
    );
  }

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
    const emitted = this.emitted.get(id) ?? { epoch: live.observationEpoch, seq: live.outputSeq };
    const epochChanged = emitted.epoch !== live.observationEpoch;
    if (!epochChanged && live.outputSeq <= emitted.seq && !done) return;
    const access = this.ctx.observe(id, epochChanged ? undefined : emitted.seq);
    const seq = access.state === 'live' ? (access.seq ?? emitted.seq) : emitted.seq;
    this.emitted.set(id, { epoch: live.observationEpoch, seq });
    for (const listener of listeners) listener(access, done);
    if (!done && seq < live.outputSeq) this.publish(id);
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
      const current = this.ctx.getLive(id);
      this.emitted.set(id, {
        epoch: current?.observationEpoch ?? access.observationEpoch,
        seq: access.seq ?? 0
      });
    }
    listeners.add(listener);
    const current = this.ctx.getLive(id);
    if ((access.seq ?? 0) < (current?.outputSeq ?? 0)) this.publish(id);
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
