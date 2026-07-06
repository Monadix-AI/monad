import { z } from 'zod';

import { clarifyChoiceModeSchema } from '../clarify.ts';
import { chatMessageSchema } from '../domain.ts';
import { messageIdSchema, nativeAgentDeliveryIdSchema, projectIdSchema } from '../ids.ts';
import {
  attachmentInputsSchema,
  messageAttachmentRefSchema,
  NATIVE_AGENT_INLINE_TEXT_MAX
} from './native-cli-agent-attachments.ts';
import { nativeAgentTurnPointerSchema } from './native-cli-agent-observation.ts';

// `text` is the inline body; `attachments` reference local files whose content is the
// human-readable payload (the stored message text is then a preview + reference markers). At least
// one must be present; the inline cap stays as the fallback DoS guard.
export const nativeAgentProjectPostRequestSchema = z
  .object({
    projectId: projectIdSchema.optional(),
    threadId: z.string().optional(),
    text: z.string().min(1).max(NATIVE_AGENT_INLINE_TEXT_MAX).optional(),
    attachments: attachmentInputsSchema.optional()
  })
  .refine((v) => v.text !== undefined || v.attachments !== undefined, 'text or attachments is required');
export type NativeAgentProjectPostRequest = z.infer<typeof nativeAgentProjectPostRequestSchema>;

export const nativeAgentProjectMessageSchema = z.object({
  id: messageIdSchema,
  projectId: projectIdSchema,
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
  projectId: projectIdSchema.optional(),
  question: z.string().min(1).max(10_000),
  options: z.array(z.string().min(1).max(1_000)).max(10).default([]),
  mode: clarifyChoiceModeSchema.default('single'),
  allowOther: z.boolean().default(true)
});
export type NativeAgentProjectAskRequest = z.infer<typeof nativeAgentProjectAskRequestSchema>;

export const nativeAgentProjectAskResponseSchema = z.object({
  ok: z.literal(true),
  requestId: z.string(),
  answer: z.string()
});
export type NativeAgentProjectAskResponse = z.infer<typeof nativeAgentProjectAskResponseSchema>;

export const nativeAgentProjectReadRequestSchema = z.object({
  projectId: projectIdSchema.optional(),
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

export const nativeCliInboxDeliveryStateSchema = z.enum(['queued', 'delivered', 'visible', 'consumed']);
export type NativeCliInboxDeliveryState = z.infer<typeof nativeCliInboxDeliveryStateSchema>;

export const nativeAgentDeliveryStateSchema = z.enum(['queued', 'delivered', 'visible', 'consumed', 'failed']);
export type NativeAgentDeliveryState = z.infer<typeof nativeAgentDeliveryStateSchema>;

export const nativeAgentDeliverySchema = z.object({
  id: nativeAgentDeliveryIdSchema,
  projectId: projectIdSchema,
  memberInstanceId: z.string().min(1),
  nativeCliSessionId: z.string().regex(/^ncli_/),
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

export const nativeCliInboxItemSchema = z.object({
  seq: z.number().int().nonnegative(),
  deliveryId: nativeAgentDeliveryIdSchema.optional(),
  deliveryState: nativeCliInboxDeliveryStateSchema.default('queued'),
  message: chatMessageSchema
});
export type NativeCliInboxItem = z.infer<typeof nativeCliInboxItemSchema>;

export const nativeAgentProjectInboxRequestSchema = z.object({ projectId: projectIdSchema.optional() }).optional();
export type NativeAgentProjectInboxRequest = z.infer<typeof nativeAgentProjectInboxRequestSchema>;

export const nativeAgentProjectInboxResponseSchema = z.object({
  items: z.array(nativeCliInboxItemSchema),
  projectId: projectIdSchema,
  cursor: z.number().int().nonnegative()
});
export type NativeAgentProjectInboxResponse = z.infer<typeof nativeAgentProjectInboxResponseSchema>;

export const nativeAgentProjectInboxAckRequestSchema = z
  .object({ projectId: projectIdSchema.optional(), cursor: z.number().int().nonnegative().optional() })
  .optional();
export type NativeAgentProjectInboxAckRequest = z.infer<typeof nativeAgentProjectInboxAckRequestSchema>;

export const nativeAgentProjectInboxAckResponseSchema = z.object({
  ok: z.literal(true),
  projectId: projectIdSchema,
  cursor: z.number().int().nonnegative()
});
export type NativeAgentProjectInboxAckResponse = z.infer<typeof nativeAgentProjectInboxAckResponseSchema>;
