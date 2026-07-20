import { z } from 'zod';

import { clarifyChoiceModeSchema } from '../clarify.ts';
import { chatMessageSchema } from '../domain.ts';
import { meshSessionIdSchema, messageIdSchema, nativeAgentDeliveryIdSchema, sessionIdSchema } from '../ids.ts';
import {
  attachmentInputsSchema,
  messageAttachmentRefSchema,
  NATIVE_AGENT_INLINE_TEXT_MAX
} from './mesh-agent-attachments.ts';
import { nativeAgentTurnPointerSchema } from './mesh-agent-observation.ts';

// `text` is the inline body; `attachments` reference local files whose content is the
// human-readable payload (the stored message text is then a preview + reference markers). At least
// one must be present; the inline cap stays as the fallback DoS guard.
export const nativeAgentProjectPostRequestSchema = z
  .object({
    sessionId: sessionIdSchema.optional(),
    threadId: z.string().optional(),
    text: z.string().min(1).max(NATIVE_AGENT_INLINE_TEXT_MAX).optional(),
    attachments: attachmentInputsSchema.optional()
  })
  .refine((v) => v.text !== undefined || v.attachments !== undefined, 'text or attachments is required');
export type NativeAgentProjectPostRequest = z.infer<typeof nativeAgentProjectPostRequestSchema>;

export const nativeAgentProjectMessageSchema = z.object({
  id: messageIdSchema,
  sessionId: sessionIdSchema,
  text: z.string(),
  attachments: z.array(messageAttachmentRefSchema).optional(),
  createdAt: z.string()
});
export type NativeAgentProjectMessage = z.infer<typeof nativeAgentProjectMessageSchema>;

export const nativeAgentProjectPostResponseSchema = z.object({
  ok: z.literal(true),
  message: nativeAgentProjectMessageSchema
});
export type NativeAgentProjectPostResponse = z.infer<typeof nativeAgentProjectPostResponseSchema>;

export const nativeAgentProjectAskRequestSchema = z.object({
  sessionId: sessionIdSchema.optional(),
  question: z.string().min(1).max(10_000),
  options: z.array(z.string().min(1).max(1_000)).max(10).default([]),
  mode: clarifyChoiceModeSchema.default('single'),
  allowOther: z.boolean().default(true),
  autoResolutionMs: z.number().int().min(60_000).max(240_000).optional()
});
export type NativeAgentProjectAskRequest = z.infer<typeof nativeAgentProjectAskRequestSchema>;

export const nativeAgentProjectAskResponseSchema = z.object({
  ok: z.literal(true),
  requestId: z.string(),
  answer: z.string()
});
export type NativeAgentProjectAskResponse = z.infer<typeof nativeAgentProjectAskResponseSchema>;

export const nativeAgentProjectReadRequestSchema = z.object({
  sessionId: sessionIdSchema.optional(),
  threadId: z.string().optional(),
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
  id: z.string().min(1),
  displayName: z.string().min(1),
  status: z.enum(['online', 'offline'])
});
export type NativeAgentSessionMember = z.infer<typeof nativeAgentSessionMemberSchema>;

export const nativeAgentSessionMembersResponseSchema = z.object({
  members: z.array(nativeAgentSessionMemberSchema)
});
export type NativeAgentSessionMembersResponse = z.infer<typeof nativeAgentSessionMembersResponseSchema>;

export const meshAgentInboxDeliveryStateSchema = z.enum(['queued', 'delivered', 'visible', 'consumed']);
export type MeshAgentInboxDeliveryState = z.infer<typeof meshAgentInboxDeliveryStateSchema>;

export const nativeAgentDeliveryStateSchema = z.enum(['queued', 'delivered', 'visible', 'consumed', 'failed']);
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

export const nativeAgentProjectInboxRequestSchema = z.object({ sessionId: sessionIdSchema.optional() }).optional();
export type NativeAgentProjectInboxRequest = z.infer<typeof nativeAgentProjectInboxRequestSchema>;

export const nativeAgentProjectInboxResponseSchema = z.object({
  items: z.array(meshAgentInboxItemSchema),
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
  cursor: z.number().int().nonnegative()
});
export type NativeAgentProjectInboxAckResponse = z.infer<typeof nativeAgentProjectInboxAckResponseSchema>;
