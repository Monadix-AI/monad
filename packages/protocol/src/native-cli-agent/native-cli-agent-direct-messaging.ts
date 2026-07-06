import { z } from 'zod';

import { messageIdSchema, projectIdSchema } from '../ids.ts';
import {
  attachmentInputsSchema,
  messageAttachmentRefSchema,
  NATIVE_AGENT_INLINE_TEXT_MAX
} from './native-cli-agent-attachments.ts';
import { nativeAgentRuntimeSchema } from './native-cli-agent-session.ts';

export const nativeAgentDirectMessageSchema = z.object({
  id: messageIdSchema,
  projectId: projectIdSchema,
  nativeCliSessionId: z.string().min(1),
  fromAgent: z.string().nullable(),
  peer: z.string(),
  text: z.string(),
  attachments: z.array(messageAttachmentRefSchema).optional(),
  createdAt: z.string()
});
export type NativeAgentDirectMessage = z.infer<typeof nativeAgentDirectMessageSchema>;

// Same inline/attachments split as project post — see nativeAgentProjectPostRequestSchema.
export const nativeAgentSendRequestSchema = z
  .object({
    to: z.string().min(1).max(200),
    text: z.string().min(1).max(NATIVE_AGENT_INLINE_TEXT_MAX).optional(),
    attachments: attachmentInputsSchema.optional()
  })
  .refine((v) => v.text !== undefined || v.attachments !== undefined, 'text or attachments is required');
export type NativeAgentSendRequest = z.infer<typeof nativeAgentSendRequestSchema>;

export const nativeAgentSendResponseSchema = z.object({
  ok: z.literal(true),
  direct: z.literal(true),
  message: nativeAgentDirectMessageSchema
});
export type NativeAgentSendResponse = z.infer<typeof nativeAgentSendResponseSchema>;

export const nativeAgentReadRequestSchema = z.object({
  with: z.string().min(1),
  before: z.string().optional(),
  after: z.string().optional(),
  limit: z.number().int().positive().max(200).optional()
});
export type NativeAgentReadRequest = z.infer<typeof nativeAgentReadRequestSchema>;

export const nativeAgentReadResponseSchema = z.object({
  with: z.string(),
  messages: z.array(nativeAgentDirectMessageSchema),
  before: z.string().optional(),
  after: z.string().optional()
});
export type NativeAgentReadResponse = z.infer<typeof nativeAgentReadResponseSchema>;

export const nativeAgentRuntimeInfoResponseSchema = z.object({
  agentId: z.string(),
  projectId: projectIdSchema,
  nativeCliSessionId: z.string(),
  runtime: nativeAgentRuntimeSchema.optional(),
  serverUrl: z.string(),
  workdir: z.string(),
  providerSessionRef: z.string().nullable().optional(),
  lastDeliveredSeq: z.number().int().nonnegative(),
  lastVisibleSeq: z.number().int().nonnegative(),
  pendingInboxCount: z.number().int().nonnegative()
});
export type NativeAgentRuntimeInfoResponse = z.infer<typeof nativeAgentRuntimeInfoResponseSchema>;
