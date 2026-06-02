import { z } from 'zod';

import { iso8601Schema, projectIdSchema, sessionIdSchema } from './ids.ts';

export const sessionAttentionStateSchema = z.enum(['need-approval', 'need-response', 'unread']);
export type SessionAttentionState = z.infer<typeof sessionAttentionStateSchema>;

export const sessionGenerationStateSchema = z.enum(['running', 'error']);
export type SessionGenerationState = z.infer<typeof sessionGenerationStateSchema>;

export const sessionAttentionSummarySchema = z.object({
  sessionId: sessionIdSchema,
  state: sessionAttentionStateSchema.nullable(),
  generationState: sessionGenerationStateSchema.nullable(),
  activityAt: iso8601Schema,
  unreadItemKeys: z.array(z.string().min(1))
});
export type SessionAttentionSummary = z.infer<typeof sessionAttentionSummarySchema>;

export const listSessionAttentionQuerySchema = z.object({
  sessionIds: z.array(sessionIdSchema).max(200)
});
export type ListSessionAttentionQuery = z.infer<typeof listSessionAttentionQuerySchema>;

export const listSessionAttentionResponseSchema = z.object({
  summaries: z.array(sessionAttentionSummarySchema)
});
export type ListSessionAttentionResponse = z.infer<typeof listSessionAttentionResponseSchema>;

export const consumeSessionAttentionRequestSchema = z.object({
  itemKeys: z.array(z.string().min(1)).max(200),
  cause: z.enum(['open', 'visible'])
});
export type ConsumeSessionAttentionRequest = z.infer<typeof consumeSessionAttentionRequestSchema>;

export const consumeSessionAttentionResponseSchema = z.object({
  consumedItemKeys: z.array(z.string().min(1))
});
export type ConsumeSessionAttentionResponse = z.infer<typeof consumeSessionAttentionResponseSchema>;

export const reorderWorkplaceProjectRequestSchema = z
  .object({
    projectId: projectIdSchema,
    beforeProjectId: projectIdSchema.optional(),
    afterProjectId: projectIdSchema.optional(),
    expectedRevision: z.number().int().nonnegative()
  })
  .refine((value) => Number(value.beforeProjectId !== undefined) + Number(value.afterProjectId !== undefined) === 1, {
    message: 'exactly one project-order breakpoint is required'
  });
export type ReorderWorkplaceProjectRequest = z.infer<typeof reorderWorkplaceProjectRequestSchema>;

export const reorderWorkplaceProjectResponseSchema = z.object({
  projectId: projectIdSchema,
  orderRevision: z.number().int().nonnegative()
});
export type ReorderWorkplaceProjectResponse = z.infer<typeof reorderWorkplaceProjectResponseSchema>;
