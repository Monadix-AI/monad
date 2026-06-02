// The agent → human question channel. Like oversight (see oversight.ts), this is a
// server-initiated request the client must answer: the agent calls the `clarify_ask` tool,
// which blocks on a promise; the daemon emits a `clarify.requested` event; a client answers
// via the `clarify.respond` RPC, unblocking the tool with the user's free-text reply.
//
// It differs from oversight only in shape (a free-text answer, not an allow/deny) and in
// timeout: a human composing an answer needs longer than a yes/no, and a timeout yields an
// empty answer (the agent proceeds with what it has) rather than a fail-closed denial.

import type { Event, SessionId } from '@monad/protocol';

import { newId } from '@monad/protocol';

interface Pending {
  resolve: (answer: string) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId: SessionId;
}

export interface ClarifyOptions {
  /** Persist + fan out an event (main.ts injects store.appendEvents + bus.publish). */
  publish: (event: Event) => void;
  /** Resolve a question with an empty answer after this long. Default 600_000ms (10 min). */
  timeoutMs?: number;
  /** Cap on concurrent pending questions — beyond it new asks resolve empty. Default 100. */
  maxPending?: number;
}

export class ClarifyService {
  private readonly pending = new Map<string, Pending>();
  private readonly publish: (event: Event) => void;
  private readonly timeoutMs: number;
  private readonly maxPending: number;

  constructor(opts: ClarifyOptions) {
    this.publish = opts.publish;
    this.timeoutMs = opts.timeoutMs ?? 600_000;
    this.maxPending = opts.maxPending ?? 100;
  }

  /** Ask the user a free-text question; resolves with their answer (or '' on timeout/overflow). */
  readonly ask = (sessionId: string, question: string, options?: string[]): Promise<string> =>
    new Promise<string>((resolve) => {
      // Bound the pending registry — a flood of questions must not accumulate unbounded
      // timers/promises. Over the cap, resolve empty (no entry created) so the agent proceeds.
      if (this.pending.size >= this.maxPending) {
        resolve('');
        return;
      }
      const requestId = newId('clarify');
      const sid = sessionId as SessionId;
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId)) {
          this.emit(sid, 'clarify.resolved', { requestId, answer: '', reason: 'timeout' });
          resolve('');
        }
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, timer, sessionId: sid });
      this.emit(sid, 'clarify.requested', { requestId, question, options });
    });

  /** Resolve a pending question. Returns false if the id is unknown or already resolved. */
  respond(requestId: string, answer: string): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    this.emit(p.sessionId, 'clarify.resolved', { requestId, answer });
    p.resolve(answer);
    return true;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private emit(
    sessionId: SessionId,
    type: 'clarify.requested' | 'clarify.resolved',
    payload: Record<string, unknown>
  ): void {
    this.publish({
      id: newId('evt'),
      sessionId,
      type,
      actorAgentId: null,
      payload,
      at: new Date().toISOString()
    });
  }
}
