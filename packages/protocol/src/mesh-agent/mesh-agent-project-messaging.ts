import { z } from 'zod';

import { clarifyChoiceModeSchema } from '../clarify.ts';
import { chatMessageSchema } from '../domain.ts';
import {
  meshSessionIdSchema,
  messageIdSchema,
  nativeAgentDeliveryIdSchema,
  projectMemberIdSchema,
  sessionIdSchema
} from '../ids.ts';
import {
  addSessionPlanTodoRequestSchema,
  deleteSessionPlanTodoRequestSchema,
  deleteSessionPlanTodoResponseSchema,
  listSessionPlanResponseSchema,
  sessionPlanTodoResponseSchema,
  updateSessionPlanTodoRequestSchema
} from '../session-plan.ts';
import {
  attachmentInputsSchema,
  messageAttachmentRefSchema,
  NATIVE_AGENT_INLINE_TEXT_MAX
} from './mesh-agent-attachments.ts';
import { meshAgentProductIconSchema, meshAgentProviderSchema } from './mesh-agent-config.ts';
import { nativeAgentDirectMessageSchema } from './mesh-agent-direct-messaging.ts';
import { nativeAgentTurnPointerSchema } from './mesh-agent-observation.ts';

// `text` is the inline body; `attachments` reference local files whose content is the
// human-readable payload (the stored message text is then a preview + reference markers). At least
// one must be present; the inline cap stays as the fallback DoS guard.
export const nativeAgentProjectPostRequestSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    sessionId: sessionIdSchema.optional(),
    replyToMessageId: messageIdSchema.optional(),
    text: z.string().min(1).max(NATIVE_AGENT_INLINE_TEXT_MAX).optional(),
    attachments: attachmentInputsSchema.optional()
  })
  .refine((v) => v.text !== undefined || v.attachments !== undefined, 'text or attachments is required');
export type NativeAgentProjectPostRequest = z.infer<typeof nativeAgentProjectPostRequestSchema>;

export const nativeAgentProjectMessageSchema = z.object({
  id: messageIdSchema,
  sessionId: sessionIdSchema,
  text: z.string(),
  replyToMessageId: messageIdSchema.optional(),
  attachments: z.array(messageAttachmentRefSchema).optional(),
  createdAt: z.string()
});
export type NativeAgentProjectMessage = z.infer<typeof nativeAgentProjectMessageSchema>;

export const nativeAgentProjectPostResponseSchema = z.object({
  ok: z.literal(true),
  message: nativeAgentProjectMessageSchema
});
export type NativeAgentProjectPostResponse = z.infer<typeof nativeAgentProjectPostResponseSchema>;

export const nativeAgentProjectQuestionSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  question: z.string().min(1).max(10_000),
  options: z.array(z.string().min(1).max(1_000)).max(10).default([]),
  mode: clarifyChoiceModeSchema.default('single'),
  allowOther: z.boolean().default(true)
});
export type NativeAgentProjectQuestion = z.infer<typeof nativeAgentProjectQuestionSchema>;

const nativeAgentProjectAskSharedSchema = z.object({
  requestId: z.string().min(1).max(200).optional(),
  sessionId: sessionIdSchema.optional(),
  blocking: z.boolean().default(false),
  autoResolutionMs: z.number().int().min(60_000).max(240_000).optional()
});

const nativeAgentProjectAskCardInputSchema = nativeAgentProjectAskSharedSchema.extend({
  questions: z.array(nativeAgentProjectQuestionSchema).min(1).max(20)
});

const nativeAgentProjectAskLegacyInputSchema = nativeAgentProjectAskSharedSchema.extend({
  question: z.string().min(1).max(10_000),
  options: z.array(z.string().min(1).max(1_000)).max(10).default([]),
  mode: clarifyChoiceModeSchema.default('single'),
  allowOther: z.boolean().default(true)
});

export const nativeAgentProjectAskRequestSchema = z
  .union([nativeAgentProjectAskCardInputSchema, nativeAgentProjectAskLegacyInputSchema])
  .transform((request) => {
    const questions =
      'questions' in request
        ? request.questions
        : [
            {
              question: request.question,
              options: request.options,
              mode: request.mode,
              allowOther: request.allowOther
            }
          ];
    return {
      ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      questions: questions.map((question, index) => ({ ...question, id: question.id ?? `q${index + 1}` })),
      blocking: request.blocking,
      ...(request.blocking
        ? request.autoResolutionMs === undefined
          ? {}
          : { autoResolutionMs: request.autoResolutionMs }
        : { autoResolutionMs: request.autoResolutionMs ?? 240_000 })
    };
  })
  .superRefine((request, ctx) => {
    const ids = new Set<string>();
    for (const [index, question] of request.questions.entries()) {
      if (ids.has(question.id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Question ids must be unique',
          path: ['questions', index, 'id']
        });
      }
      ids.add(question.id);
    }
  });
export type NativeAgentProjectAskInput = z.input<typeof nativeAgentProjectAskRequestSchema>;
export type NativeAgentProjectAskRequest = z.output<typeof nativeAgentProjectAskRequestSchema>;

const nativeAgentProjectAskAnsweredResponseSchema = z.object({
  ok: z.literal(true),
  requestId: z.string(),
  status: z.literal('answered'),
  answer: z.string(),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())]))
});

const nativeAgentProjectAskTerminalResponseSchema = z.object({
  ok: z.literal(true),
  requestId: z.string(),
  status: z.enum(['skipped', 'timed_out', 'cancelled'])
});

const nativeAgentProjectAskAwaitingHumanResponseSchema = z.object({
  ok: z.literal(true),
  requestId: z.string(),
  status: z.literal('awaiting_human'),
  instruction: z.literal('end_turn')
});

const nativeAgentProjectAskLegacyResponseSchema = z
  .object({
    ok: z.literal(true),
    requestId: z.string(),
    answer: z.string()
  })
  .transform((response) => ({
    ...response,
    status: 'answered' as const,
    answers: { q1: response.answer }
  }));

export const nativeAgentProjectAskResponseSchema = z.union([
  nativeAgentProjectAskAnsweredResponseSchema,
  nativeAgentProjectAskTerminalResponseSchema,
  nativeAgentProjectAskAwaitingHumanResponseSchema,
  nativeAgentProjectAskLegacyResponseSchema
]);
export type NativeAgentProjectAskResponseInput = z.input<typeof nativeAgentProjectAskResponseSchema>;
export type NativeAgentProjectAskResponse = z.output<typeof nativeAgentProjectAskResponseSchema>;

export const nativeAgentProjectAskCancelRequestSchema = z.object({
  requestId: z.string().min(1).max(200),
  cause: z.enum(['timeout', 'cancelled', 'transport_eof'])
});
export type NativeAgentProjectAskCancelRequest = z.infer<typeof nativeAgentProjectAskCancelRequestSchema>;

export const nativeAgentProjectAskCancelResponseSchema = z.object({
  ok: z.literal(true),
  requestId: z.string(),
  status: z.enum(['timed_out', 'cancelled', 'detached_sync', 'answered', 'skipped'])
});
export type NativeAgentProjectAskCancelResponse = z.infer<typeof nativeAgentProjectAskCancelResponseSchema>;

export const nativeAgentProjectReadRequestSchema = z.object({
  sessionId: sessionIdSchema.optional(),
  messageId: messageIdSchema.optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  around: z.string().optional(),
  limit: z.number().int().positive().max(200).optional()
});
export type NativeAgentProjectReadRequest = z.infer<typeof nativeAgentProjectReadRequestSchema>;

export const nativeAgentProjectReadResponseSchema = z.object({
  messages: z.array(chatMessageSchema)
});
export type NativeAgentProjectReadResponse = z.infer<typeof nativeAgentProjectReadResponseSchema>;

export const nativeAgentSessionMemberSchema = z.object({
  id: projectMemberIdSchema,
  displayName: z.string().min(1),
  provider: meshAgentProviderSchema.optional(),
  productIcon: meshAgentProductIconSchema.optional(),
  status: z.enum(['online', 'offline'])
});
export type NativeAgentSessionMember = z.infer<typeof nativeAgentSessionMemberSchema>;

export const nativeAgentSessionMembersResponseSchema = z.object({
  members: z.array(nativeAgentSessionMemberSchema)
});
export type NativeAgentSessionMembersResponse = z.infer<typeof nativeAgentSessionMembersResponseSchema>;

export const meshAgentInboxDeliveryStateSchema = z.enum(['queued', 'delivered', 'visible', 'consumed']);
export type MeshAgentInboxDeliveryState = z.infer<typeof meshAgentInboxDeliveryStateSchema>;

export const nativeAgentDeliveryStateSchema = z.enum([
  'queued',
  'claimed',
  'delivered',
  'visible',
  'consumed',
  'failed'
]);
export type NativeAgentDeliveryState = z.infer<typeof nativeAgentDeliveryStateSchema>;

export const nativeAgentDeliverySchema = z.object({
  id: nativeAgentDeliveryIdSchema,
  sessionId: sessionIdSchema,
  memberInstanceId: z.string().min(1),
  meshSessionId: meshSessionIdSchema,
  triggerMessageId: messageIdSchema.optional(),
  triggerMessageSeq: z.number().int().nonnegative(),
  state: nativeAgentDeliveryStateSchema,
  turn: nativeAgentTurnPointerSchema.default({}),
  errorSummary: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional()
});
export type NativeAgentDelivery = z.infer<typeof nativeAgentDeliverySchema>;

export const getNativeAgentDeliveryResponseSchema = z.object({
  delivery: nativeAgentDeliverySchema
});
export type GetNativeAgentDeliveryResponse = z.infer<typeof getNativeAgentDeliveryResponseSchema>;

export const meshAgentInboxItemSchema = z.object({
  seq: z.number().int().nonnegative(),
  deliveryId: nativeAgentDeliveryIdSchema.optional(),
  deliveryState: meshAgentInboxDeliveryStateSchema.default('queued'),
  message: chatMessageSchema
});
export type MeshAgentInboxItem = z.infer<typeof meshAgentInboxItemSchema>;

const nativeAgentPendingInboxItemBaseSchema = z.object({
  ingressSeq: z.number().int().positive(),
  deliveryId: nativeAgentDeliveryIdSchema,
  createdAt: z.string()
});

export const nativeAgentPendingInboxItemSchema = z.discriminatedUnion('source', [
  nativeAgentPendingInboxItemBaseSchema.extend({
    source: z.literal('project'),
    messageSeq: z.number().int().nonnegative(),
    message: chatMessageSchema
  }),
  nativeAgentPendingInboxItemBaseSchema.extend({
    source: z.literal('direct'),
    message: nativeAgentDirectMessageSchema
  })
]);
export type NativeAgentPendingInboxItem = z.infer<typeof nativeAgentPendingInboxItemSchema>;

export const nativeAgentProjectInboxRequestSchema = z.object({ sessionId: sessionIdSchema.optional() }).optional();
export type NativeAgentProjectInboxRequest = z.infer<typeof nativeAgentProjectInboxRequestSchema>;

export const nativeAgentProjectInboxResponseSchema = z.object({
  items: z.array(nativeAgentPendingInboxItemSchema),
  sessionId: sessionIdSchema,
  cursor: z.number().int().nonnegative()
});
export type NativeAgentProjectInboxResponse = z.infer<typeof nativeAgentProjectInboxResponseSchema>;

export const nativeAgentProjectInboxAckRequestSchema = z
  .object({ sessionId: sessionIdSchema.optional(), cursor: z.number().int().nonnegative().optional() })
  .optional();
export type NativeAgentProjectInboxAckRequest = z.infer<typeof nativeAgentProjectInboxAckRequestSchema>;

export const nativeAgentProjectInboxAckResponseSchema = z.object({
  ok: z.literal(true),
  sessionId: sessionIdSchema,
  cursor: z.number().int().nonnegative(),
  requestedCursor: z.number().int().nonnegative(),
  visibleCursor: z.number().int().nonnegative(),
  consumedDeliveryIds: z.array(nativeAgentDeliveryIdSchema),
  deferredDeliveryIds: z.array(nativeAgentDeliveryIdSchema)
});
export type NativeAgentProjectInboxAckResponse = z.infer<typeof nativeAgentProjectInboxAckResponseSchema>;

// ── Session plan (P0-C), managed-agent internal proxy. `sessionId` is never a body field on any of
// these — the calling runtime's bound session is the only session it can ever touch, so the wire
// derives sessionId from `requireManagedBinding`, not from client input (omit, not "optional and
// validated", so a forged sessionId can't even parse into these types).
export const nativeAgentProjectPlanListResponseSchema = listSessionPlanResponseSchema;
export type NativeAgentProjectPlanListResponse = z.infer<typeof nativeAgentProjectPlanListResponseSchema>;

export const nativeAgentProjectPlanAddRequestSchema = addSessionPlanTodoRequestSchema.omit({ sessionId: true });
export type NativeAgentProjectPlanAddRequest = z.infer<typeof nativeAgentProjectPlanAddRequestSchema>;

export const nativeAgentProjectPlanUpdateRequestSchema = updateSessionPlanTodoRequestSchema.omit({
  sessionId: true
});
export type NativeAgentProjectPlanUpdateRequest = z.infer<typeof nativeAgentProjectPlanUpdateRequestSchema>;

export const nativeAgentProjectPlanDeleteRequestSchema = deleteSessionPlanTodoRequestSchema.omit({
  sessionId: true
});
export type NativeAgentProjectPlanDeleteRequest = z.infer<typeof nativeAgentProjectPlanDeleteRequestSchema>;

export const nativeAgentProjectPlanTodoResponseSchema = sessionPlanTodoResponseSchema;
export type NativeAgentProjectPlanTodoResponse = z.infer<typeof nativeAgentProjectPlanTodoResponseSchema>;

export const nativeAgentProjectPlanDeleteResponseSchema = deleteSessionPlanTodoResponseSchema;
export type NativeAgentProjectPlanDeleteResponse = z.infer<typeof nativeAgentProjectPlanDeleteResponseSchema>;
