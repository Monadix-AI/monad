import { z } from 'zod';

import { messageRoleSchema, messageTypeSchema } from './domain.ts';
import {
  agentIdSchema,
  idempotencyKeySchema,
  meshSessionIdSchema,
  messageIdSchema,
  nativeAgentDeliveryIdSchema,
  transcriptTargetIdSchema
} from './ids.ts';

export const messageProducerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: z.string().min(1).optional() }),
  z.object({
    kind: z.literal('mesh-agent'),
    meshSessionId: meshSessionIdSchema,
    agentName: z.string().min(1).optional(),
    deliveryId: nativeAgentDeliveryIdSchema.optional()
  }),
  z.object({
    kind: z.literal('agent'),
    agentId: agentIdSchema,
    meshSessionId: meshSessionIdSchema.optional()
  }),
  z.object({
    kind: z.literal('agent-facing-mcp'),
    serverId: z.string().min(1).optional(),
    agentId: agentIdSchema.optional()
  }),
  z.object({ kind: z.literal('channel'), channel: z.string().min(1), senderId: z.string().min(1).optional() }),
  z.object({ kind: z.literal('system'), subsystem: z.string().min(1) })
]);
export type MessageProducer = z.infer<typeof messageProducerSchema>;

const durableMessageCommandSchema = z.object({
  transcriptTargetId: transcriptTargetIdSchema,
  idempotencyKey: idempotencyKeySchema,
  producer: messageProducerSchema
});

const createMessageFields = {
  role: messageRoleSchema,
  type: messageTypeSchema,
  text: z.string(),
  data: z.unknown().optional(),
  includeInContext: z.boolean().optional()
};

export const deliverMessageCommandSchema = durableMessageCommandSchema.extend(createMessageFields);
export type DeliverMessageCommand = z.infer<typeof deliverMessageCommandSchema>;

export const beginMessageCommandSchema = durableMessageCommandSchema.extend(createMessageFields);
export type BeginMessageCommand = z.infer<typeof beginMessageCommandSchema>;

export const appendMessageCommandSchema = z.object({
  transcriptTargetId: transcriptTargetIdSchema,
  messageId: messageIdSchema,
  producer: messageProducerSchema,
  channel: z.string().min(1),
  index: z.number().int().nonnegative(),
  delta: z.string()
});
export type AppendMessageCommand = z.infer<typeof appendMessageCommandSchema>;

export const updateMessageCommandSchema = durableMessageCommandSchema.extend({
  messageId: messageIdSchema,
  updates: z
    .object({
      text: z.string().optional(),
      type: messageTypeSchema.optional(),
      data: z.unknown().optional(),
      includeInContext: z.boolean().optional(),
      active: z.boolean().optional()
    })
    .refine((updates) => Object.keys(updates).length > 0, 'at least one message update is required')
});
export type UpdateMessageCommand = z.infer<typeof updateMessageCommandSchema>;

export const settleMessageCommandSchema = durableMessageCommandSchema.extend({
  messageId: messageIdSchema,
  text: z.string(),
  type: messageTypeSchema.optional(),
  data: z.unknown().optional(),
  includeInContext: z.boolean().optional()
});
export type SettleMessageCommand = z.infer<typeof settleMessageCommandSchema>;

export const failMessageCommandSchema = durableMessageCommandSchema.extend({
  messageId: messageIdSchema,
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }),
  type: messageTypeSchema.optional(),
  data: z.unknown().optional(),
  includeInContext: z.boolean().optional()
});
export type FailMessageCommand = z.infer<typeof failMessageCommandSchema>;

export const removeMessageCommandSchema = durableMessageCommandSchema.extend({
  messageId: messageIdSchema
});
export type RemoveMessageCommand = z.infer<typeof removeMessageCommandSchema>;
