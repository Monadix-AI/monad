import { z } from 'zod';

import { messageIdSchema, PROJECT_MEMBER_ID_MAX_LENGTH, projectMemberIdSchema, sessionIdSchema } from '../ids.ts';
import {
  attachmentInputsSchema,
  messageAttachmentRefSchema,
  NATIVE_AGENT_INLINE_TEXT_MAX
} from './mesh-agent-attachments.ts';
import { nativeAgentRuntimeSchema } from './mesh-session.ts';

// One shared address contract for every direct-message identity string: the `to`/`with` addressing input,
// the stored `peer`, and the resolved `with` in the read response. A peer is EITHER a canonical project
// member (resolved to its projectMemberId) OR a free-form private label (e.g. a human the agent keeps a
// private ledger with, delivered nowhere) — no reliable syntax tells them apart, so this is a bounded
// string, not projectMemberIdSchema. The ceiling must be at least a canonical id's, or a resolved member
// peer/`with` could exceed it and fail response validation; private labels share the same bound.
const directMessageAddressSchema = z.string().min(1).max(PROJECT_MEMBER_ID_MAX_LENGTH);

export const nativeAgentDirectMessageSchema = z.object({
  id: messageIdSchema,
  sessionId: sessionIdSchema,
  meshSessionId: z.string().min(1),
  // The sender is always a canonical projectMemberId (null only for system-injected messages). The peer
  // is a member pmid when it resolves to one, else the raw private label — see directMessagePeerSchema.
  fromAgent: projectMemberIdSchema.nullable(),
  peer: directMessageAddressSchema,
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
    to: directMessageAddressSchema,
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
  with: directMessageAddressSchema,
  before: z.string().optional(),
  after: z.string().optional(),
  limit: z.number().int().positive().max(200).optional()
});
export type NativeAgentReadRequest = z.infer<typeof nativeAgentReadRequestSchema>;

export const nativeAgentReadResponseSchema = z.object({
  // The resolved peer for this conversation: a canonical member pmid when `with` matched a member, else the
  // raw private label. Reply by passing it straight back as `to`; map a member pmid to a display name via
  // `session_members`, not a daemon-side projection.
  with: directMessageAddressSchema,
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
