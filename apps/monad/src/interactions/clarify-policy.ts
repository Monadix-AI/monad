// Clarify message/event policy — the persistence and wire shaping for durable agent→human questions,
// factored out of the interaction lifecycle. This module is pure policy: it builds message commands,
// canonical answer text, and event payloads. It owns no pending map, no timers, and no terminal
// lifecycle — those belong to the single active-interaction authority in `service.ts`, which folds
// clarify in as one interaction kind.

import type {
  ClarifyAsker,
  ClarifyChoiceMode,
  ClarifyMessageData,
  ClarifyRespondResponse,
  EventPayloadInput,
  MessageId,
  MessageProducer,
  TranscriptTargetId
} from '@monad/protocol';
import type { MessageIngress } from '#/services/messages/types.ts';

import { meshSessionIdSchema, messageIdSchema } from '@monad/protocol';

import { messageIdempotencyKey } from '#/services/messages/ingress.ts';

export const AUTOMATIC_SETTLEMENT_ATTEMPTS = 3;
export const AUTOMATIC_SETTLEMENT_RETRY_MAX_MS = 1_000;

export interface ClarifyAskRequest {
  requestId?: string;
  question: string;
  questions?: Array<{
    id: string;
    question: string;
    options: string[];
    mode: ClarifyChoiceMode;
    allowOther: boolean;
  }>;
  blocking?: boolean;
  options?: string[];
  mode?: ClarifyChoiceMode;
  allowOther?: boolean;
  asker?: ClarifyAsker;
  autoResolutionMs?: number;
  form?: import('@monad/protocol').ClarifyForm;
  urlElicitation?: import('@monad/protocol').UrlElicitation;
  origin?: { kind: 'daemon-agent' } | { kind: 'managed-project'; meshSessionId: string; agentId: string };
  questionMessage?: { id: MessageId; createdAt: string };
}

export interface ClarifyAskResult {
  requestId: string;
  answer: string;
  status: 'answered' | 'timed-out' | 'cancelled';
  answerMessageId?: MessageId;
}

export interface RecoveredClarificationAnswer {
  requestId: string;
  sessionId: import('@monad/protocol').TranscriptTargetId;
  question: string;
  answer: string;
  answerMessageId: MessageId;
  origin: NonNullable<ClarifyAskRequest['origin']>;
}

function clarifyProducerFor(request: ClarifyAskRequest): MessageProducer {
  if (request.origin?.kind === 'managed-project') {
    return {
      kind: 'mesh-agent',
      meshSessionId: meshSessionIdSchema.parse(request.origin.meshSessionId),
      agentName: request.asker?.name ?? request.origin.agentId
    };
  }
  return { kind: 'system', subsystem: 'clarify' };
}

function clarifyData(
  requestId: string,
  request: ClarifyAskRequest,
  status: ClarifyMessageData['status']
): ClarifyMessageData {
  return {
    requestId,
    question: request.question,
    options: request.options ?? [],
    mode: request.mode ?? 'single',
    allowOther: request.allowOther ?? true,
    ...(request.form ? { form: request.form } : {}),
    ...(request.urlElicitation ? { urlElicitation: request.urlElicitation } : {}),
    status
  };
}

function canonicalAnswerText(answer: string): string {
  try {
    const parsed = JSON.parse(answer) as unknown;
    if (typeof parsed === 'string') return parsed;
    if (Array.isArray(parsed) && parsed.every((value): value is string => typeof value === 'string')) {
      return parsed.join(', ');
    }
  } catch {
    return answer;
  }
  return answer;
}

// The active-record fields the settlement mechanics read. The service's clarify record satisfies this
// structurally; policy never touches the record's map/lifecycle fields (timer, resolve, settlement).
export interface ClarifyRecordRef {
  id: string;
  sessionId: TranscriptTargetId;
  questionMessageId: MessageId;
  ownsQuestionMessage: boolean;
  request: ClarifyAskRequest;
}

/** Commit the canonical question message (idempotent by request id) and return it. */
export async function deliverClarifyQuestion(
  ingress: MessageIngress,
  sessionId: TranscriptTargetId,
  requestId: string,
  request: ClarifyAskRequest
): Promise<{ id: MessageId; createdAt: string }> {
  return ingress.deliver({
    transcriptTargetId: sessionId,
    idempotencyKey: messageIdempotencyKey('clarify-question', sessionId, requestId),
    producer: clarifyProducerFor(request),
    role: 'assistant',
    type: 'clarify',
    text: request.question,
    data: clarifyData(requestId, request, 'pending')
  });
}

/** Build the `clarify.requested` event payload from a request + its committed question message. */
export function clarifyRequestedPayload(
  requestId: string,
  request: ClarifyAskRequest,
  questionMessageId: MessageId,
  expiresAt: string | undefined
): EventPayloadInput<'clarify.requested'> {
  return {
    requestId,
    question: request.question,
    ...(request.questions ? { questions: request.questions } : {}),
    ...(request.blocking === undefined ? {} : { blocking: request.blocking }),
    questionMessageId,
    ...(request.options ? { options: request.options } : {}),
    ...(request.mode ? { mode: request.mode } : {}),
    ...(request.allowOther !== undefined ? { allowOther: request.allowOther } : {}),
    ...(request.form ? { form: request.form } : {}),
    ...(request.urlElicitation ? { urlElicitation: request.urlElicitation } : {}),
    ...(request.asker ? { asker: request.asker } : {}),
    ...(request.autoResolutionMs ? { autoResolutionMs: request.autoResolutionMs, expiresAt } : {}),
    origin: request.origin ?? { kind: 'daemon-agent' }
  };
}

export interface ClarifySettlement {
  answerMessageId?: MessageId;
  resolved: EventPayloadInput<'clarify.resolved'>;
  result: ClarifyRespondResponse;
}

/** Perform a clarification's message side effects — commit the canonical answer (when answered) and
 *  stamp the question's terminal status — then return the `clarify.resolved` payload and the terminal
 *  result. The service publishes the event and runs the single terminal transition; this owns no map,
 *  timer, or waiter. */
export async function settleClarifyMessages(
  record: ClarifyRecordRef,
  answer: string,
  status: 'answered' | 'timed-out' | 'cancelled',
  ingress: MessageIngress
): Promise<ClarifySettlement> {
  const answerMessage =
    status === 'answered'
      ? await ingress.deliver({
          transcriptTargetId: record.sessionId,
          idempotencyKey: messageIdempotencyKey('clarify-answer', record.sessionId, record.id),
          producer: { kind: 'user' },
          role: 'user',
          type: 'text',
          text: canonicalAnswerText(answer),
          replyToMessageId: record.questionMessageId
        })
      : undefined;
  if (record.ownsQuestionMessage) {
    await ingress.update({
      transcriptTargetId: record.sessionId,
      messageId: record.questionMessageId,
      idempotencyKey: messageIdempotencyKey('clarify-question-status', record.sessionId, record.id, status),
      producer: clarifyProducerFor(record.request),
      updates: { data: clarifyData(record.id, record.request, status) }
    });
  }

  const resolvedAt = new Date().toISOString();
  const parsedAnswers = (() => {
    if (!record.request.questions || !answer.trim()) return undefined;
    try {
      const value = JSON.parse(answer) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      return value as Record<string, string | string[]>;
    } catch {
      return undefined;
    }
  })();
  const eventStatus =
    status === 'timed-out' ? 'timed_out' : status === 'cancelled' ? 'cancelled' : answer ? 'answered' : 'skipped';
  return {
    answerMessageId: answerMessage?.id,
    resolved: {
      requestId: record.id,
      answer,
      ...(parsedAnswers ? { answers: parsedAnswers } : {}),
      status: eventStatus,
      questionMessageId: record.questionMessageId,
      ...(answerMessage ? { answerMessageId: answerMessage.id } : {}),
      ...(status === 'timed-out' ? { reason: 'timeout' } : {}),
      ...(status === 'cancelled' ? { reason: 'cancelled' } : {})
    },
    result: status === 'answered' ? { status, answer, resolvedAt } : { status, resolvedAt }
  };
}

/** Reconstruct the persisted request + question anchor from a durable `clarify.requested` event. The
 *  service wraps this in a full active record and registers it through its one register path. */
export function restoredClarifyRequest(payload: EventPayloadInput<'clarify.requested'>): {
  request: ClarifyAskRequest;
  questionMessageId: MessageId;
  ownsQuestionMessage: boolean;
} {
  return {
    request: {
      requestId: payload.requestId,
      question: payload.question,
      questions: payload.questions?.map((question) => ({
        ...question,
        options: question.options ?? [],
        mode: question.mode ?? 'single',
        allowOther: question.allowOther ?? true
      })),
      blocking: payload.blocking,
      options: payload.options,
      mode: payload.mode,
      allowOther: payload.allowOther,
      form: payload.form,
      urlElicitation: payload.urlElicitation,
      asker: payload.asker,
      autoResolutionMs: payload.autoResolutionMs,
      origin: payload.origin
    },
    questionMessageId: messageIdSchema.parse(payload.questionMessageId),
    ownsQuestionMessage: payload.origin?.kind !== 'managed-project'
  };
}
