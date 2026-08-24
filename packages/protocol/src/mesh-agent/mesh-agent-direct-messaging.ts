import { z } from 'zod';

import { messageIdSchema, projectMemberIdSchema, sessionIdSchema } from '../ids.ts';
import {
  attachmentInputsSchema,
  messageAttachmentRefSchema,
  NATIVE_AGENT_INLINE_TEXT_MAX
} from './mesh-agent-attachments.ts';
import { nativeAgentRuntimeSchema } from './mesh-session.ts';

export const nativeAgentDeliveryModeSchema = z.enum(['queue', 'steer']);
export type NativeAgentDeliveryMode = z.infer<typeof nativeAgentDeliveryModeSchema>;

export const nativeAgentDirectMessageSchema = z.object({
  id: messageIdSchema,
  sessionId: sessionIdSchema,
  meshSessionId: z.string().min(1),
  // Both endpoints are canonical project-member identities. Direct messaging never performs alias/name
  // addressing and never stores a free-form private-label peer.
  fromAgent: projectMemberIdSchema.nullable(),
  peer: projectMemberIdSchema,
  text: z.string(),
  attachments: z.array(messageAttachmentRefSchema).optional(),
  createdAt: z.string()
});
export type NativeAgentDirectMessage = z.infer<typeof nativeAgentDirectMessageSchema>;

export const meshAgentDirectMessageMessageDataSchema = z
  .object({
    message: nativeAgentDirectMessageSchema
  })
  .strict();
export type MeshAgentDirectMessageMessageData = z.infer<typeof meshAgentDirectMessageMessageDataSchema>;

// Same inline/attachments split as project post — see nativeAgentProjectPostRequestSchema.
export const nativeAgentSendRequestSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    to: projectMemberIdSchema,
    deliveryMode: nativeAgentDeliveryModeSchema.optional(),
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
  with: projectMemberIdSchema,
  before: z.string().optional(),
  after: z.string().optional(),
  limit: z.number().int().positive().max(200).optional()
});
export type NativeAgentReadRequest = z.infer<typeof nativeAgentReadRequestSchema>;

export const nativeAgentReadResponseSchema = z.object({
  // The canonical member id used to key this conversation. Reply by passing it straight back as `to`.
  with: projectMemberIdSchema,
  messages: z.array(nativeAgentDirectMessageSchema),
  before: z.string().optional(),
  after: z.string().optional()
});
export type NativeAgentReadResponse = z.infer<typeof nativeAgentReadResponseSchema>;

export const nativeAgentRuntimeInfoResponseSchema = z
  .object({
    projectMemberId: projectMemberIdSchema,
    sessionId: sessionIdSchema,
    meshSessionId: z.string(),
    runtime: nativeAgentRuntimeSchema.optional(),
    serverUrl: z.string(),
    workdir: z.string(),
    providerSessionRef: z.string().nullable().optional(),
    lastDeliveredSeq: z.number().int().nonnegative(),
    lastVisibleSeq: z.number().int().nonnegative(),
    pendingInboxCount: z.number().int().nonnegative()
  })
  // Strict so a raw strict-parse of the wire fails if the removed legacy `agentId` (or the internal
  // legacyDeliveryKey) ever leaks onto the runtime-info response.
  .strict();
export type NativeAgentRuntimeInfoResponse = z.infer<typeof nativeAgentRuntimeInfoResponseSchema>;
