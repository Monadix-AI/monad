// Clarify orchestration: ask / respond / settle / auto-timeout retry / durable restore / recovered
// continuation, plus the clarify sinks, config, and the post-terminal idempotency ledger. It holds NO
// active-record map — the one `#pending` and its `register`/`terminate`/reservation transitions live in
// InteractionService and are reached only through the injected `ClarifyHost` callbacks. Message and
// event shaping is delegated to clarify-policy.

import type { ClarifyRespondResponse, Event, EventPayloadInput, TranscriptTargetId } from '@monad/protocol';
import type { MessageIngress } from '#/services/messages/types.ts';
import type { ActiveInteraction, ClarifyInteraction } from './types';

import { newId, transcriptTargetIdSchema } from '@monad/protocol';

import { makeEvent } from '#/services/event-bus.ts';
import {
  AUTOMATIC_SETTLEMENT_ATTEMPTS,
  AUTOMATIC_SETTLEMENT_RETRY_MAX_MS,
  type ClarifyAskRequest,
  type ClarifyAskResult,
  clarifyRequestedPayload,
  deliverClarifyQuestion,
  type RecoveredClarificationAnswer,
  restoredClarifyRequest,
  settleClarifyMessages
} from './clarify-policy';

/** The subset of the interaction service the clarify capability drives. Every active-record mutation
 *  (reserve / register / terminate) funnels back through here, so the single lifecycle authority stays
 *  in InteractionService and this capability never owns a competing map. */
export interface ClarifyHost {
  now(): number;
  getActive(id: string): ActiveInteraction | undefined;
  isReserved(id: string): boolean;
  reserveId(id: string): void;
  releaseId(id: string): void;
  register(record: ClarifyInteraction): number;
  getClarify(id: string): ClarifyInteraction | undefined;
  terminate(record: ClarifyInteraction, result: ClarifyRespondResponse): void;
  countClarify(): number;
}

export type ClarifyCapabilityOptions = {
  ingress: MessageIngress;
  publish: (event: Event) => void;
  lookupTerminal?: (requestId: string) => ClarifyRespondResponse | null;
  maxPending?: number;
  /** Test clock override; it never makes an omitted autoResolutionMs expire. */
  timeoutMs?: number;
  /** Unresolved clarify.requested events loaded from the durable event log at startup. */
  restore?: Event[];
};

type ClarifyRequestedEvent = Event & {
  type: 'clarify.requested';
  payload: EventPayloadInput<'clarify.requested'>;
};

// Durable identity of a clarification: two records with the same id are the same request only when all
// of these match. A restore whose id collides but whose anchor differs is a real conflict, not a replay.
function clarifyAnchor(record: ClarifyInteraction): string {
  return JSON.stringify({
    sessionId: record.sessionId,
    questionMessageId: record.questionMessageId,
    question: record.request.question,
    options: record.request.options ?? null,
    mode: record.request.mode ?? null,
    allowOther: record.request.allowOther ?? null,
    blocking: record.request.blocking ?? null,
    autoResolutionMs: record.request.autoResolutionMs ?? null,
    questions: record.request.questions ?? null,
    asker: record.request.asker ?? null,
    origin: record.request.origin ?? null
  });
}

export class ClarifyCapability {
  readonly #host: ClarifyHost;
  readonly #ingress: MessageIngress;
  readonly #publish: (event: Event) => void;
  readonly #lookupTerminal?: (requestId: string) => ClarifyRespondResponse | null;
  readonly #maxPending: number;
  readonly #timeoutMs?: number;
  // Post-terminal idempotency ledger. Not an active map — entries are read to short-circuit a repeat
  // response and never re-enter `#pending`.
  readonly #terminals = new Map<string, ClarifyRespondResponse>();
  #reservations = 0;
  #recoveredContinuation?: (answer: RecoveredClarificationAnswer) => Promise<void>;

  constructor(options: ClarifyCapabilityOptions, host: ClarifyHost) {
    this.#host = host;
    this.#ingress = options.ingress;
    this.#publish = options.publish;
    this.#lookupTerminal = options.lookupTerminal;
    this.#maxPending = options.maxPending ?? 100;
    this.#timeoutMs = options.timeoutMs;
  }

  get pendingCount(): number {
    return this.#host.countClarify();
  }

  setRecoveredContinuation(callback: (answer: RecoveredClarificationAnswer) => Promise<void>): void {
    this.#recoveredContinuation = callback;
  }

  readonly ask = (sessionId: string, request: ClarifyAskRequest): Promise<ClarifyAskResult> =>
    this.askStructured(sessionId, request);

  readonly askStructured = async (
    sessionId: string,
    request: ClarifyAskRequest,
    _opts?: { signal?: AbortSignal }
  ): Promise<ClarifyAskResult> => {
    if (this.pendingCount + this.#reservations >= this.#maxPending) {
      throw new Error('pending clarification capacity exceeded');
    }
    const requestId = request.requestId ?? newId('clarify');
    // Claim the id synchronously, before the async question commit, so a second concurrent ask with the
    // same id — or a structured request whose createId() lands on it — fails closed here instead of both
    // reaching register and the later one silently overwriting the first (orphaning its waiter).
    if (this.#host.getActive(requestId) || this.#terminals.has(requestId) || this.#host.isReserved(requestId)) {
      throw new Error(`clarification request already exists: ${requestId}`);
    }
    this.#reservations += 1;
    this.#host.reserveId(requestId);
    try {
      const sid = transcriptTargetIdSchema.parse(sessionId);
      const questionMessage =
        request.questionMessage ?? (await deliverClarifyQuestion(this.#ingress, sid, requestId, request));

      return new Promise<ClarifyAskResult>((resolve) => {
        const clarifyDelayMs =
          request.autoResolutionMs === undefined ? undefined : (this.#timeoutMs ?? request.autoResolutionMs);
        const record: ClarifyInteraction = {
          kind: 'clarify',
          id: requestId,
          request,
          sessionId: sid,
          questionMessageId: questionMessage.id,
          ownsQuestionMessage: request.questionMessage === undefined,
          createdAt: this.#host.now(),
          expiresAt: Number.POSITIVE_INFINITY,
          clarifyDelayMs,
          resolve
        };
        const armedAt = this.#host.register(record);
        const expiresAt =
          request.autoResolutionMs === undefined || clarifyDelayMs === undefined
            ? undefined
            : new Date(armedAt + request.autoResolutionMs).toISOString();
        if (expiresAt) record.expiresAt = Date.parse(expiresAt);
        this.#emit(
          sid,
          'clarify.requested',
          clarifyRequestedPayload(requestId, request, questionMessage.id, expiresAt),
          questionMessage.createdAt
        );
      });
    } finally {
      this.#host.releaseId(requestId);
      this.#reservations -= 1;
    }
  };

  async respond(
    requestId: string,
    answer: string | undefined,
    action?: 'complete' | 'cancel'
  ): Promise<ClarifyRespondResponse> {
    const existing = this.#terminals.get(requestId) ?? this.#lookupTerminal?.(requestId);
    if (existing) {
      const record = this.#host.getClarify(requestId);
      if (record) this.#host.terminate(record, existing);
      return existing;
    }
    const record = this.#host.getClarify(requestId);
    if (!record) return { status: 'not-found' };
    if (action && !record.request.urlElicitation) throw new Error('clarification does not support URL actions');
    if (record.request.urlElicitation && action === undefined && answer !== undefined) {
      const fallbackAction = legacyUrlAction(answer);
      if (fallbackAction === 'cancel') return this.#startSettlement(record, '', 'cancelled');
      if (fallbackAction === 'complete') action = 'complete';
    }
    if (action === 'cancel') return this.#startSettlement(record, '', 'cancelled');
    const resolvedAnswer = action === 'complete' ? 'Completed' : (answer ?? '');
    return this.#startSettlement(record, resolvedAnswer, resolvedAnswer.trim() ? 'answered' : 'cancelled');
  }

  /** Called by the service's register timer when a clarification's auto-resolution window elapses. */
  onTimeout(record: ClarifyInteraction): void {
    void this.#settleTimeout(record, record.clarifyDelayMs ?? 0);
  }

  /** Called by the service's single terminal transition after it removes the record from `#pending`:
   *  record the durable terminal, resolve the waiter, and continue a recovered (restored) answer once. */
  onTerminated(record: ClarifyInteraction, terminal: ClarifyRespondResponse): void {
    if (terminal.status === 'not-found') return;
    this.#terminals.set(record.id, terminal);
    const answer = terminal.status === 'answered' ? terminal.answer : '';
    record.resolve?.({
      requestId: record.id,
      answer,
      status: terminal.status,
      ...(record.answerMessageId ? { answerMessageId: record.answerMessageId } : {})
    });
    if (terminal.status === 'answered' && record.answerMessageId && !record.resolve && this.#recoveredContinuation) {
      void this.#recoveredContinuation({
        requestId: record.id,
        sessionId: record.sessionId,
        question: record.request.question,
        answer: terminal.answer,
        answerMessageId: record.answerMessageId,
        origin: record.request.origin ?? { kind: 'daemon-agent' }
      });
    }
  }

  /** Replay unresolved clarify.requested events from the durable log. Runs after the capability is
   *  attached to the service so a fatal collision leaves an inspectable (fail-closed) state. */
  restore(events: Event[]): void {
    for (const event of events) {
      if (event.type !== 'clarify.requested') continue;
      this.#restoreOne(event as ClarifyRequestedEvent);
    }
  }

  #restoreOne(event: ClarifyRequestedEvent): void {
    const { requestId, expiresAt } = event.payload;
    // Already settled durably → nothing to restore (terminal semantics), regardless of anchor.
    if (this.#terminals.get(requestId) ?? this.#lookupTerminal?.(requestId)) return;
    const { request, questionMessageId, ownsQuestionMessage } = restoredClarifyRequest(event.payload);
    const clarifyDelayMs = expiresAt === undefined ? undefined : Math.max(0, Date.parse(expiresAt) - this.#host.now());
    const candidate: ClarifyInteraction = {
      kind: 'clarify',
      id: requestId,
      request,
      sessionId: event.sessionId,
      questionMessageId,
      ownsQuestionMessage,
      createdAt: this.#host.now(),
      expiresAt: expiresAt ? Date.parse(expiresAt) : Number.POSITIVE_INFINITY,
      clarifyDelayMs
    };
    const existing = this.#host.getActive(requestId);
    if (existing) {
      if (existing.kind !== 'clarify') {
        throw new Error(
          `clarify restore id collision: ${requestId} is already an active ${existing.kind} interaction ` +
            `(restore candidate session=${candidate.sessionId} question=${candidate.questionMessageId})`
        );
      }
      if (clarifyAnchor(existing) !== clarifyAnchor(candidate)) {
        throw new Error(
          `clarify restore id collision: ${requestId} has a different anchor — ` +
            `candidate session=${candidate.sessionId} question=${candidate.questionMessageId} vs ` +
            `existing session=${existing.sessionId} question=${existing.questionMessageId}`
        );
      }
      return; // identical replay — idempotent skip, the live record is left untouched.
    }
    this.#host.register(candidate);
  }

  async #startSettlement(
    record: ClarifyInteraction,
    answer: string,
    status: 'answered' | 'timed-out' | 'cancelled'
  ): Promise<ClarifyRespondResponse> {
    if (record.settlement) return record.settlement;
    const settlement = this.#settle(record, answer, status);
    record.settlement = settlement;
    try {
      return await settlement;
    } catch (error) {
      if (record.settlement === settlement) record.settlement = undefined;
      throw error;
    }
  }

  async #settle(
    record: ClarifyInteraction,
    answer: string,
    status: 'answered' | 'timed-out' | 'cancelled'
  ): Promise<ClarifyRespondResponse> {
    // Mechanics (message commit, resolved payload, terminal result) live in clarify-policy; this owns
    // only the lifecycle: stamp the answer anchor, publish, and run the service's one terminal transition.
    const settlement = await settleClarifyMessages(record, answer, status, this.#ingress);
    record.answerMessageId = settlement.answerMessageId;
    this.#emit(record.sessionId, 'clarify.resolved', settlement.resolved);
    this.#host.terminate(record, settlement.result);
    return settlement.result;
  }

  async #settleTimeout(record: ClarifyInteraction, retryDelayMs: number): Promise<void> {
    for (let attempt = 0; attempt < AUTOMATIC_SETTLEMENT_ATTEMPTS; attempt += 1) {
      if (this.#host.getActive(record.id) !== record) return;
      try {
        await this.#startSettlement(record, '', 'timed-out');
        return;
      } catch {
        const terminal = this.#lookupTerminal?.(record.id);
        if (terminal) {
          this.#host.terminate(record, terminal);
          return;
        }
        if (attempt + 1 < AUTOMATIC_SETTLEMENT_ATTEMPTS) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, Math.min(retryDelayMs, AUTOMATIC_SETTLEMENT_RETRY_MAX_MS));
          });
        }
      }
    }

    if (this.#host.getActive(record.id) !== record) return;
    const resolvedAt = new Date().toISOString();
    try {
      this.#emit(record.sessionId, 'clarify.resolved', {
        requestId: record.id,
        answer: '',
        questionMessageId: record.questionMessageId,
        reason: 'settlement_failed'
      });
    } finally {
      this.#host.terminate(record, { status: 'cancelled', resolvedAt });
    }
  }

  #emit<T extends 'clarify.requested' | 'clarify.resolved'>(
    sessionId: TranscriptTargetId,
    type: T,
    payload: EventPayloadInput<T>,
    at?: string
  ): void {
    this.#publish(makeEvent(sessionId, type, payload, at ? { at } : undefined));
  }
}

function legacyUrlAction(answer: string): 'complete' | 'cancel' | undefined {
  const normalized = answer.trim().toLowerCase();
  if (['complete', 'completed', 'done'].includes(normalized)) return 'complete';
  if (['cancel', 'cancelled', 'decline'].includes(normalized)) return 'cancel';
  return undefined;
}
