import { z } from 'zod';

import { chatMessageSchema } from './domain.ts';
import { meshSessionIdSchema, projectIdSchema, sessionIdSchema } from './ids.ts';

const inboxContextSchema = z.object({
  projectId: projectIdSchema.optional(),
  projectName: z.string().optional(),
  sessionId: sessionIdSchema,
  sessionTitle: z.string().optional(),
  createdAt: z.string()
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

export const inboxItemSchema = z.discriminatedUnion('kind', [mentionInboxItemSchema, approvalInboxItemSchema]);
export type InboxItem = z.infer<typeof inboxItemSchema>;

export const listMentionInboxQuerySchema = z.object({
  limit: z.number().int().positive().max(200).optional()
});
export type ListMentionInboxQuery = z.infer<typeof listMentionInboxQuerySchema>;

export const listMentionInboxResponseSchema = z.object({
  items: z.array(inboxItemSchema)
});
export type ListMentionInboxResponse = z.infer<typeof listMentionInboxResponseSchema>;
