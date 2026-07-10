import { z } from 'zod';

import { chatMessageSchema } from './domain.ts';
import { externalAgentInboxDeliveryStateSchema } from './external-agent/external-agent-project-messaging.ts';
import {
  externalAgentSessionIdSchema,
  messageIdSchema,
  nativeAgentDeliveryIdSchema,
  projectIdSchema,
  sessionIdSchema
} from './ids.ts';

export const mentionInboxItemSchema = z.object({
  id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  deliveryId: nativeAgentDeliveryIdSchema.optional(),
  deliveryState: externalAgentInboxDeliveryStateSchema.default('queued'),
  externalAgentSessionId: externalAgentSessionIdSchema,
  projectId: projectIdSchema.optional(),
  projectName: z.string().optional(),
  sessionId: sessionIdSchema,
  sessionTitle: z.string().optional(),
  memberInstanceId: z.string().optional(),
  triggerMessageId: messageIdSchema.optional(),
  message: chatMessageSchema,
  createdAt: z.string(),
  updatedAt: z.string().optional()
});
export type MentionInboxItem = z.infer<typeof mentionInboxItemSchema>;

export const listMentionInboxQuerySchema = z.object({
  limit: z.number().int().positive().max(200).optional()
});
export type ListMentionInboxQuery = z.infer<typeof listMentionInboxQuerySchema>;

export const listMentionInboxResponseSchema = z.object({
  items: z.array(mentionInboxItemSchema)
});
export type ListMentionInboxResponse = z.infer<typeof listMentionInboxResponseSchema>;
