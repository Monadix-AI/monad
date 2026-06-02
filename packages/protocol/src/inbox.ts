import { z } from 'zod';

import { clarifyFormSchema } from './clarify.ts';
import { chatMessageSchema } from './domain.ts';
import { meshSessionIdSchema, projectIdSchema, sessionIdSchema } from './ids.ts';
import { nativeAgentProjectQuestionSchema } from './mesh-agent/mesh-agent-project-messaging.ts';

const inboxContextSchema = z.object({
  itemKey: z.string().min(1),
  projectId: projectIdSchema.optional(),
  projectName: z.string().optional(),
  sessionId: sessionIdSchema,
  sessionTitle: z.string().optional(),
  createdAt: z.string(),
  readAt: z.string().optional(),
  actionState: z.enum(['informational', 'needs-response', 'completed', 'timed-out', 'cancelled']),
  resolvedAt: z.string().optional()
});

export const mentionInboxItemSchema = inboxContextSchema.extend({
  kind: z.literal('mention'),
  id: z.string().min(1),
  message: chatMessageSchema,
  agentName: z.string().optional()
});
export type MentionInboxItem = z.infer<typeof mentionInboxItemSchema>;

export const approvalInboxItemSchema = inboxContextSchema.extend({
  kind: z.literal('approval'),
  id: z.string().min(1),
  approvalKind: z.enum(['tool', 'mesh-agent']),
  tool: z.string().optional(),
  input: z.unknown().optional(),
  key: z.string().optional(),
  meshSessionId: meshSessionIdSchema.optional(),
  provider: z.string().optional(),
  text: z.string().optional()
});
export type ApprovalInboxItem = z.infer<typeof approvalInboxItemSchema>;

export const hitlInboxItemSchema = inboxContextSchema.extend({
  kind: z.literal('hitl'),
  id: z.string().min(1),
  requestId: z.string().min(1),
  question: z.string().min(1),
  questions: z.array(nativeAgentProjectQuestionSchema.extend({ id: z.string().min(1) })).optional(),
  options: z.array(z.string()).optional(),
  mode: z.enum(['single', 'multiple']).optional(),
  allowOther: z.boolean().optional(),
  form: clarifyFormSchema.optional(),
  asker: z
    .object({
      id: z.string().optional(),
      name: z.string()
    })
    .optional(),
  autoResolutionMs: z.number().int().min(60_000).max(240_000).optional(),
  expiresAt: z.string().optional(),
  answer: z.string().optional(),
  resolutionReason: z.enum(['answered', 'timeout', 'cancelled']).optional()
});
export type HitlInboxItem = z.infer<typeof hitlInboxItemSchema>;

export const inboxItemSchema = z.discriminatedUnion('kind', [
  mentionInboxItemSchema,
  approvalInboxItemSchema,
  hitlInboxItemSchema
]);
export type InboxItem = z.infer<typeof inboxItemSchema>;

export const inboxFilterSchema = z.enum(['all', 'needs-response', 'unread', 'completed']);
export type InboxFilter = z.infer<typeof inboxFilterSchema>;

export const listInboxQuerySchema = z.object({
  filter: inboxFilterSchema.optional(),
  limit: z.number().int().positive().max(200).optional(),
  cursor: z.string().min(1).max(500).optional()
});
export type ListInboxQuery = z.infer<typeof listInboxQuerySchema>;

export const listInboxResponseSchema = z.object({
  items: z.array(inboxItemSchema),
  nextCursor: z.string().optional()
});
export type ListInboxResponse = z.infer<typeof listInboxResponseSchema>;

export const inboxSummarySchema = z.object({
  unreadCount: z.number().int().nonnegative(),
  needsResponseCount: z.number().int().nonnegative()
});
export type InboxSummary = z.infer<typeof inboxSummarySchema>;

export const markInboxReadRequestSchema = z.object({
  itemKeys: z.array(z.string().min(1)).min(1).max(100)
});
export type MarkInboxReadRequest = z.infer<typeof markInboxReadRequestSchema>;

export const markInboxReadResponseSchema = z.object({
  readAt: z.string(),
  itemKeys: z.array(z.string().min(1))
});
export type MarkInboxReadResponse = z.infer<typeof markInboxReadResponseSchema>;

export const markInboxUnreadRequestSchema = markInboxReadRequestSchema;
export type MarkInboxUnreadRequest = z.infer<typeof markInboxUnreadRequestSchema>;

export const markInboxUnreadResponseSchema = z.object({
  itemKeys: z.array(z.string().min(1))
});
export type MarkInboxUnreadResponse = z.infer<typeof markInboxUnreadResponseSchema>;

export const markAllInboxReadResponseSchema = z.object({
  readAt: z.string(),
  count: z.number().int().nonnegative()
});
export type MarkAllInboxReadResponse = z.infer<typeof markAllInboxReadResponseSchema>;

export const listMentionInboxQuerySchema = z.object({
  limit: z.number().int().positive().max(200).optional()
});
export type ListMentionInboxQuery = z.infer<typeof listMentionInboxQuerySchema>;

export const listMentionInboxResponseSchema = z.object({
  items: z.array(inboxItemSchema)
});
export type ListMentionInboxResponse = z.infer<typeof listMentionInboxResponseSchema>;
