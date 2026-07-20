import type { MessageSendParams, TaskIdParams, TaskQueryParams } from '@a2a-js/sdk';

import { z } from 'zod';

const metadataSchema = z.record(z.string(), z.unknown());
const textPartSchema = z.object({ kind: z.literal('text'), text: z.string(), metadata: metadataSchema.optional() });
const fileValueSchema = z.union([
  z.object({ bytes: z.string(), mimeType: z.string().optional(), name: z.string().optional() }),
  z.object({ uri: z.string(), mimeType: z.string().optional(), name: z.string().optional() })
]);
const filePartSchema = z.object({
  kind: z.literal('file'),
  file: fileValueSchema,
  metadata: metadataSchema.optional()
});
const dataPartSchema = z.object({ kind: z.literal('data'), data: metadataSchema, metadata: metadataSchema.optional() });
const partSchema = z.discriminatedUnion('kind', [textPartSchema, filePartSchema, dataPartSchema]);
const messageSchema = z.object({
  contextId: z.string().optional(),
  extensions: z.array(z.string()).optional(),
  kind: z.literal('message'),
  messageId: z.string(),
  metadata: metadataSchema.optional(),
  parts: z.array(partSchema),
  referenceTaskIds: z.array(z.string()).optional(),
  role: z.enum(['agent', 'user']),
  taskId: z.string().optional()
});
const pushNotificationConfigSchema = z.object({
  authentication: z.object({ credentials: z.string().optional(), schemes: z.array(z.string()) }).optional(),
  id: z.string().optional(),
  token: z.string().optional(),
  url: z.string()
});

export const messageSendParamsSchema: z.ZodType<MessageSendParams> = z.object({
  configuration: z
    .object({
      acceptedOutputModes: z.array(z.string()).optional(),
      blocking: z.boolean().optional(),
      historyLength: z.number().optional(),
      pushNotificationConfig: pushNotificationConfigSchema.optional()
    })
    .optional(),
  message: messageSchema,
  metadata: metadataSchema.optional()
});

export const taskQueryParamsSchema: z.ZodType<TaskQueryParams> = z.object({
  historyLength: z.number().optional(),
  id: z.string(),
  metadata: metadataSchema.optional()
});

export const taskIdParamsSchema: z.ZodType<TaskIdParams> = z.object({
  id: z.string(),
  metadata: metadataSchema.optional()
});
