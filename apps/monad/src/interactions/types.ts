// Shared in-process types for the interaction service, its validation helpers, and the clarify
// capability. Kept separate so the pure validators and the clarify orchestrator can name the routing
// and active-record shapes without importing the service (which imports them back).

import type {
  ClarifyRespondResponse,
  InteractionProducer,
  InteractionRequest,
  InteractionResult,
  MessageId,
  TranscriptTargetId
} from '@monad/protocol';
import type { ClarifyAskRequest, ClarifyAskResult } from './clarify-policy';

export type InteractionRouting = {
  mode: 'foreground' | 'background';
  preferredPresenterId?: string;
};

export type InteractionCancellationReason = Extract<InteractionResult, { status: 'cancelled' }>['reason'];

type Lease = {
  presenterId: string;
  token: string;
  expiresAt: number;
};

// A structured host interaction (confirm/select/form) awaiting a presenter claim + submission.
export type StructuredInteraction = {
  kind: 'structured';
  id: string;
  source: InteractionProducer;
  sourceKey: string;
  request: InteractionRequest;
  routing: InteractionRouting;
  createdAt: number;
  expiresAt: number;
  lease?: Lease;
  timeout?: ReturnType<typeof setTimeout>;
  resolve: (result: InteractionResult) => void;
};

// A durable agent→human clarification awaiting a human answer (or an automatic-timeout settlement).
// It shares the one active-record lifecycle with structured interactions: the service's `#register`
// makes it active and arms its optional auto-resolution timer; `#terminate` removes it and fires its
// outcome. Message/event shaping lives in clarify-policy; orchestration in clarify-capability.
export type ClarifyInteraction = {
  kind: 'clarify';
  id: string;
  request: ClarifyAskRequest;
  sessionId: TranscriptTargetId;
  questionMessageId: MessageId;
  ownsQuestionMessage: boolean;
  createdAt: number;
  expiresAt: number;
  // Concrete delay armed for auto-resolution (a test clock may shorten it); undefined = human-only.
  clarifyDelayMs?: number;
  timeout?: ReturnType<typeof setTimeout>;
  // Absent for a request restored from the durable log — its original waiter no longer exists.
  resolve?: (result: ClarifyAskResult) => void;
  answerMessageId?: MessageId;
  // The single in-flight terminal settlement; concurrent responses share it.
  settlement?: Promise<ClarifyRespondResponse>;
};

/** Any active interaction the service owns, discriminated by `kind`. */
export type ActiveInteraction = StructuredInteraction | ClarifyInteraction;
