import { z } from 'zod';

export const chatTextPartSchema = z.object({ type: z.literal('text'), text: z.string() }).passthrough();
const chatOtherPartSchema = z.object({ type: z.string().refine((type) => type !== 'text') }).passthrough();
const chatContentSchema = z.union([z.string(), z.null(), z.array(z.union([chatTextPartSchema, chatOtherPartSchema]))]);

const chatMessageSchema = z
  .object({
    role: z.enum(['developer', 'system', 'user', 'assistant', 'tool', 'function']),
    content: chatContentSchema.optional(),
    name: z.string().optional(),
    tool_call_id: z.string().optional()
  })
  .passthrough();

export const chatCompletionRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(chatMessageSchema).min(1),
    max_tokens: z.number().int().positive().nullable().optional(),
    n: z.number().int().positive().optional(),
    response_format: z.object({ type: z.string() }).passthrough().optional(),
    stop: z
      .union([z.string(), z.array(z.string())])
      .nullable()
      .optional(),
    stream: z.boolean().optional(),
    temperature: z.number().nullable().optional(),
    user: z.string().optional()
  })
  .passthrough();

export const embeddingRequestSchema = z
  .object({
    input: z.union([z.string().min(1), z.array(z.string()).min(1)]),
    model: z.string().optional()
  })
  .passthrough();

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
export type ChatContent = z.infer<typeof chatContentSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type EmbeddingRequest = z.infer<typeof embeddingRequestSchema>;
