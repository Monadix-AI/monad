import type { SessionId } from '@monad/protocol';
import type { ModelMessage } from '@monad/sdk-atom';
import type { Response as OAIResponse, ResponseCreateParamsBase } from 'openai/resources/responses/responses';

import { z } from 'zod';

// ── Responses API wire types ──────────────────────────────────────────────────
// All openai SDK imports are type-only — erased at bundle time.

const jsonObjectSchema = z.record(z.string(), z.unknown());
const responseInputContentSchema = z.object({ type: z.string(), text: z.string().optional() }).passthrough();
export const responseMessageInputSchema = z.object({
  type: z.literal('message').optional(),
  role: z.enum(['user', 'assistant', 'system', 'developer']),
  content: z.union([z.string(), z.array(responseInputContentSchema)])
});
export const responseFunctionCallInputSchema = z.object({
  type: z.literal('function_call'),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
  id: z.string().optional(),
  status: z.enum(['in_progress', 'completed', 'incomplete']).optional()
});
export const responseFunctionCallOutputInputSchema = z.object({
  type: z.literal('function_call_output'),
  call_id: z.string(),
  output: z.union([z.string(), z.array(jsonObjectSchema)]),
  id: z.string().optional(),
  status: z.enum(['in_progress', 'completed', 'incomplete']).optional()
});
const responseOtherInputSchema = z
  .object({
    type: z.string().refine((type) => type !== 'function_call' && type !== 'function_call_output')
  })
  .passthrough();
const responseInputItemSchema = z.union([
  responseFunctionCallInputSchema,
  responseFunctionCallOutputInputSchema,
  responseMessageInputSchema,
  responseOtherInputSchema
]);
const responseInputSchema = z.union([z.string(), z.array(responseInputItemSchema)]);

export const responseFunctionToolSchema = z.object({
  type: z.literal('function'),
  name: z.string(),
  parameters: jsonObjectSchema.nullable(),
  strict: z.boolean().nullable(),
  description: z.string().nullable().optional()
});
const responseOtherToolSchema = z.object({ type: z.string().refine((type) => type !== 'function') }).passthrough();
const responseToolSchema = z.union([responseFunctionToolSchema, responseOtherToolSchema]);

const responsesRequestShapeSchema = z.object({
  model: z.string().min(1),
  input: responseInputSchema,
  instructions: z.string().nullable().optional(),
  max_output_tokens: z.number().int().positive().nullable().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  previous_response_id: z.string().nullable().optional(),
  store: z.boolean().nullable().optional(),
  stream: z.boolean().nullable().optional(),
  temperature: z.number().nullable().optional(),
  text: z
    .object({ format: z.object({ type: z.string() }).passthrough().optional() })
    .passthrough()
    .optional(),
  tool_choice: z
    .custom<NonNullable<ResponseCreateParamsBase['tool_choice']>>(
      (value) =>
        value === 'none' || value === 'auto' || value === 'required' || (typeof value === 'object' && value !== null)
    )
    .optional(),
  tools: z.array(responseToolSchema).optional(),
  top_p: z.number().nullable().optional()
});

export const responsesRequestSchema = responsesRequestShapeSchema;
export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;
export type ResponsesInput = z.infer<typeof responseInputSchema>;
export type ResponsesFunctionTool = z.infer<typeof responseFunctionToolSchema>;

// OAIResponse covers every required field the OpenAI wire format mandates.
// x_monad is our vendor extension for session/agent/cost metadata.
export type ResponseObject = OAIResponse & {
  x_monad?: { session_id: string; agent_id?: string; cost_usd?: number };
};

export type StoredResponse = {
  response: ResponseObject;
  sessionId: SessionId;
  lastUsed: number;
  /** Message history for function-tool mode (no session used). */
  toolMessages?: ModelMessage[];
};
