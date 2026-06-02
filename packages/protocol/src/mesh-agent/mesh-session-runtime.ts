import { z } from 'zod';

import { messageAttachmentRefSchema, NATIVE_AGENT_ATTACHMENTS_MAX } from './mesh-agent-attachments.ts';

export const meshAgentRuntimeFailureSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean()
});
export type MeshAgentRuntimeFailure = z.infer<typeof meshAgentRuntimeFailureSchema>;

export const meshSessionLifecycleSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('starting') }),
  z.object({ state: z.literal('active') }),
  z.object({
    state: z.literal('terminal'),
    termination: z.object({
      kind: z.enum(['exited', 'stopped', 'failed']),
      at: z.string(),
      exitCode: z.number().int().nullable().optional(),
      error: meshAgentRuntimeFailureSchema.optional()
    })
  })
]);
export type MeshSessionLifecycle = z.infer<typeof meshSessionLifecycleSchema>;

export const meshExecutionActivitySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('idle'), pid: z.null(), queuedTurnCount: z.literal(0) }),
  z.object({
    state: z.literal('starting'),
    pid: z.number().int().positive().nullable(),
    queuedTurnCount: z.number().int().nonnegative()
  }),
  z.object({
    state: z.literal('running'),
    pid: z.number().int().positive(),
    queuedTurnCount: z.number().int().nonnegative()
  }),
  z.object({
    state: z.literal('suspended'),
    pid: z.null(),
    suspendedAt: z.string(),
    queuedTurnCount: z.number().int().nonnegative()
  })
]);
export type MeshExecutionActivity = z.infer<typeof meshExecutionActivitySchema>;

export const meshConnectionConditionSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('inactive') }),
  z.object({ state: z.literal('connecting') }),
  z.object({ state: z.literal('connected') }),
  z.object({
    state: z.literal('reconnecting'),
    attempt: z.number().int().positive(),
    nextAttemptAt: z.string().optional()
  })
]);
export type MeshConnectionCondition = z.infer<typeof meshConnectionConditionSchema>;

export const meshAgentRuntimeCapabilitiesSchema = z.object({
  input: z.boolean(),
  steer: z.boolean(),
  interrupt: z.boolean(),
  approvalResolution: z.boolean(),
  providerSessionContinuation: z.boolean(),
  runtimeRestoration: z.boolean(),
  sessionReopen: z.boolean()
});
export type MeshAgentRuntimeCapabilities = z.infer<typeof meshAgentRuntimeCapabilitiesSchema>;

export const meshAgentTurnAttachmentSchema = messageAttachmentRefSchema.pick({
  id: true,
  path: true,
  name: true,
  mime: true,
  bytes: true
});
export type MeshAgentTurnAttachment = z.infer<typeof meshAgentTurnAttachmentSchema>;

export const meshAgentTurnInputSchema = z.object({
  text: z.string(),
  attachments: z.array(meshAgentTurnAttachmentSchema).max(NATIVE_AGENT_ATTACHMENTS_MAX)
});
export type MeshAgentTurnInput = z.infer<typeof meshAgentTurnInputSchema>;
