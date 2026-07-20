// Durable agent -> human questions. A missing autoResolutionMs means that only a human response
// (or an explicit cancellation) may settle the request; transport disconnects are deliberately
// ignored because the request remains actionable from Inbox.

import type {
  ClarifyAsker,
  ClarifyChoiceMode,
  ClarifyRespondResponse,
  Event,
  EventPayloadInput,
  TranscriptTargetId
} from '@monad/protocol';

import { newId, transcriptTargetIdSchema } from '@monad/protocol';

import { makeEvent } from '#/services/event-bus.ts';

interface Pending {
  resolve?: (answer: string) => void;
  timer?: ReturnType<typeof setTimeout>;
  sessionId: TranscriptTargetId;
  request: ClarifyAskRequest;
}

export interface RecoveredClarificationAnswer {
  requestId: string;
  sessionId: TranscriptTargetId;
  question: string;
  answer: string;
  origin: NonNullable<ClarifyAskRequest['origin']>;
}

export interface ClarifyAskRequest {
  question: string;
  options?: string[];
  mode?: ClarifyChoiceMode;
  allowOther?: boolean;
  asker?: ClarifyAsker;
  autoResolutionMs?: number;
  origin?: { kind: 'daemon-agent' } | { kind: 'managed-project'; meshSessionId: string; agentId: string };
}

export interface ClarifyAskResult {
  requestId: string;
  answer: string;
}

export interface ClarifyOptions {
  publish: (event: Event) => void;
  lookupTerminal?: (requestId: string) => ClarifyRespondResponse | null;
  maxPending?: number;
  /** Test clock override; it never makes an omitted autoResolutionMs expire. */
  timeoutMs?: number;
  /** Unresolved clarify.requested events loaded from the durable event log at startup. */
  restore?: Event[];
}

export class ClarifyService {
  private readonly pending = new Map<string, Pending>();
  private readonly terminals = new Map<string, ClarifyRespondResponse>();
  private readonly publish: (event: Event) => void;
  private readonly maxPending: number;
  private readonly timeoutMs?: number;
  private readonly lookupTerminal?: (requestId: string) => ClarifyRespondResponse | null;
  private recoveredContinuation?: (answer: RecoveredClarificationAnswer) => Promise<void>;

  constructor(opts: ClarifyOptions) {
    this.publish = opts.publish;
    this.maxPending = opts.maxPending ?? 100;
    this.timeoutMs = opts.timeoutMs;
    this.lookupTerminal = opts.lookupTerminal;
    for (const event of opts.restore ?? []) {
      if (event.type !== 'clarify.requested') continue;
      this.restore(
        event as Event & {
          type: 'clarify.requested';
          payload: EventPayloadInput<'clarify.requested'>;
        }
      );
    }
  }

  readonly ask = async (sessionId: string, request: ClarifyAskRequest): Promise<string> =>
    (await this.askStructured(sessionId, request)).answer;

  readonly askStructured = (
    sessionId: string,
    request: ClarifyAskRequest,
    _opts?: { signal?: AbortSignal }
  ): Promise<ClarifyAskResult> => {
    if (this.pending.size >= this.maxPending) {
      return Promise.reject(new Error('pending clarification capacity exceeded'));
    }
    const requestId = newId('clarify');
    const sid = transcriptTargetIdSchema.parse(sessionId);
    const createdAt = new Date();
    const expiresAt = request.autoResolutionMs
      ? new Date(createdAt.getTime() + request.autoResolutionMs).toISOString()
      : undefined;

    return new Promise<ClarifyAskResult>((resolve) => {
      this.pending.set(requestId, { resolve: (answer) => resolve({ requestId, answer }), request, sessionId: sid });
      this.armTimer(
        requestId,
        request.autoResolutionMs === undefined ? undefined : (this.timeoutMs ?? request.autoResolutionMs)
      );
      this.emit(
        sid,
        'clarify.requested',
        {
          requestId,
          question: request.question,
          ...(request.options ? { options: request.options } : {}),
          ...(request.mode ? { mode: request.mode } : {}),
          ...(request.allowOther !== undefined ? { allowOther: request.allowOther } : {}),
          ...(request.asker ? { asker: request.asker } : {}),
          ...(request.autoResolutionMs ? { autoResolutionMs: request.autoResolutionMs, expiresAt } : {}),
          origin: request.origin ?? { kind: 'daemon-agent' }
        },
        createdAt.toISOString()
      );
    });
  };

  respond(requestId: string, answer: string): ClarifyRespondResponse {
    const existing = this.terminals.get(requestId) ?? this.lookupTerminal?.(requestId);
    if (existing) return existing;
    const pending = this.pending.get(requestId);
    if (!pending) return { status: 'not-found' };
    return this.settle(requestId, pending, answer, 'answered');
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  setRecoveredContinuation(callback: (answer: RecoveredClarificationAnswer) => Promise<void>): void {
    this.recoveredContinuation = callback;
  }

  private restore(event: Event & { type: 'clarify.requested'; payload: EventPayloadInput<'clarify.requested'> }): void {
    const { requestId, expiresAt } = event.payload;
    this.pending.set(requestId, {
      sessionId: event.sessionId,
      request: {
        question: event.payload.question,
        options: event.payload.options,
        mode: event.payload.mode,
        allowOther: event.payload.allowOther,
        asker: event.payload.asker,
        autoResolutionMs: event.payload.autoResolutionMs,
        origin: event.payload.origin
      }
    });
    if (expiresAt) this.armTimer(requestId, Math.max(0, Date.parse(expiresAt) - Date.now()));
  }

  private armTimer(requestId: string, delayMs?: number): void {
    if (delayMs === undefined) return;
    const timer = setTimeout(() => {
      const pending = this.pending.get(requestId);
      if (pending) this.settle(requestId, pending, '', 'timed-out');
    }, delayMs);
    const pending = this.pending.get(requestId);
    if (pending) pending.timer = timer;
  }

  private settle(
    requestId: string,
    pending: Pending,
    answer: string,
    status: 'answered' | 'timed-out' | 'cancelled'
  ): ClarifyRespondResponse {
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(requestId);
    const resolvedAt = new Date().toISOString();
    this.emit(pending.sessionId, 'clarify.resolved', {
      requestId,
      answer,
      ...(status === 'timed-out' ? { reason: 'timeout' } : {}),
      ...(status === 'cancelled' ? { reason: 'cancelled' } : {})
    });
    pending.resolve?.(answer);
    const result: ClarifyRespondResponse =
      status === 'answered' ? { status, answer, resolvedAt } : { status, resolvedAt };
    this.terminals.set(requestId, result);
    if (status === 'answered' && !pending.resolve && this.recoveredContinuation) {
      void this.recoveredContinuation({
        requestId,
        sessionId: pending.sessionId,
        question: pending.request.question,
        answer,
        origin: pending.request.origin ?? { kind: 'daemon-agent' }
      });
    }
    return result;
  }

  private emit<T extends 'clarify.requested' | 'clarify.resolved'>(
    sessionId: TranscriptTargetId,
    type: T,
    payload: EventPayloadInput<T>,
    at?: string
  ): void {
    this.publish(makeEvent(sessionId, type, payload, at ? { at } : undefined));
  }
}
