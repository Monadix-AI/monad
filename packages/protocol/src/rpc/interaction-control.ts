import { z } from 'zod';

import { approvalScopeSchema } from '../approvals.ts';

export const toolApproveRequestSchema = z.object({
  requestId: z.string(),
  allow: z.boolean(),
  reason: z.string().max(500).optional(),
  scope: approvalScopeSchema.optional()
});
export type ToolApproveRequest = z.infer<typeof toolApproveRequestSchema>;

export const toolApproveResponseSchema = z.object({ ok: z.boolean() });
export type ToolApproveResponse = z.infer<typeof toolApproveResponseSchema>;

export const clarifyRespondRequestSchema = z
  .object({
    requestId: z.string(),
    answer: z.string().max(10_000).optional(),
    action: z.enum(['complete', 'cancel']).optional()
  })
  .refine((value) => Number(value.answer !== undefined) + Number(value.action !== undefined) === 1, {
    message: 'exactly one of answer or action is required'
  });
export type ClarifyRespondRequest = z.infer<typeof clarifyRespondRequestSchema>;

export const clarifyRespondResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('answered'), answer: z.string(), resolvedAt: z.string() }),
  z.object({ status: z.literal('timed-out'), resolvedAt: z.string() }),
  z.object({ status: z.literal('cancelled'), resolvedAt: z.string() }),
  z.object({ status: z.literal('not-found') })
]);
export type ClarifyRespondResponse = z.infer<typeof clarifyRespondResponseSchema>;
