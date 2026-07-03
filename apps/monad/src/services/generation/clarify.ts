// The agent → human question channel. Like oversight (see oversight.ts), this is a
// server-initiated request the client must answer: the agent calls the `clarify_ask` tool,
// which blocks on a promise; the daemon emits a `clarify.requested` event; a client answers
// via the `clarify.respond` RPC, unblocking the tool with the user's free-text reply.
//
// It differs from oversight only in shape (a free-text answer, not an allow/deny) and in
// timeout: a human composing an answer needs longer than a yes/no, and a timeout yields an
// empty answer (the agent proceeds with what it has) rather than a fail-closed denial.

import type { ClarifyAsker, ClarifyChoiceMode, Event, TranscriptTargetId } from '@monad/protocol';

import { newId } from '@monad/protocol';

interface Pending {
  resolve: (answer: string) => void;
  timer?: ReturnType<typeof setTimeout>;
  cleanup?: () => void;
  sessionId: TranscriptTargetId;
}

export interface ClarifyAskRequest {
  question: string;
  options?: string[];
  mode?: ClarifyChoiceMode;
  allowOther?: boolean;
  asker?: ClarifyAsker;
}

export interface ClarifyAskResult {
  requestId: string;
  answer: string;
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
  readonly ask = async (sessionId: string, question: string, options?: string[]): Promise<string> =>
    (await this.askStructured(sessionId, { question, options })).answer;

  /** Ask the user a structured question; resolves with their answer (or '' on timeout/overflow).
   *  `waitForever: true` skips the auto-resolve timer — the promise settles only on a human answer. */
  readonly askStructured = (
    sessionId: string,
    request: ClarifyAskRequest,
    opts?: { signal?: AbortSignal; waitForever?: boolean }
  ): Promise<ClarifyAskResult> =>
    new Promise<ClarifyAskResult>((resolve) => {
      // Bound the pending registry — a flood of questions must not accumulate unbounded
      // timers/promises. Over the cap, resolve empty (no entry created) so the agent proceeds.
      if (this.pending.size >= this.maxPending) {
        resolve({ requestId: '', answer: '' });
        return;
      }
      const requestId = newId('clarify');
      const sid = sessionId as TranscriptTargetId;
      if (opts?.signal?.aborted) {
        resolve({ requestId, answer: '' });
        return;
      }
      const settle = (answer: string, reason?: string) => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        if (pending.timer) clearTimeout(pending.timer);
        pending.cleanup?.();
        this.pending.delete(requestId);
        this.emit(sid, 'clarify.resolved', { requestId, answer, ...(reason ? { reason } : {}) });
        resolve({ requestId, answer });
      };
      const timer = opts?.waitForever
        ? undefined
        : setTimeout(() => {
            settle('', 'timeout');
          }, this.timeoutMs);
      const onAbort = () => settle('', 'aborted');
      opts?.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(requestId, {
        resolve: (answer) => settle(answer),
        timer,
        cleanup: opts?.signal ? () => opts.signal?.removeEventListener('abort', onAbort) : undefined,
        sessionId: sid
      });
      this.emit(sid, 'clarify.requested', {
        requestId,
        question: request.question,
        ...(request.options ? { options: request.options } : {}),
        ...(request.mode ? { mode: request.mode } : {}),
        ...(request.allowOther !== undefined ? { allowOther: request.allowOther } : {}),
        ...(request.asker ? { asker: request.asker } : {})
      });
    });

  /** Resolve a pending question. Returns false if the id is unknown or already resolved. */
  respond(requestId: string, answer: string): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    p.resolve(answer);
    return true;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private emit(
    sessionId: TranscriptTargetId,
    type: 'clarify.requested' | 'clarify.resolved',
    payload: Record<string, unknown>
  ): void {
    this.publish({
      id: newId('evt'),
      transcriptTargetId: sessionId,
      type,
      actorAgentId: null,
      payload,
      at: new Date().toISOString()
    });
  }
}
