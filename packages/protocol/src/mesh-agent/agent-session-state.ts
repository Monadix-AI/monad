import { z } from 'zod';

import { meshSessionIdSchema, sessionIdSchema } from '../ids.ts';
import { meshAgentRuntimeFailureSchema } from './mesh-session-runtime.ts';

export const agentSessionLifecycleSchema = z.enum(['initializing', 'active', 'released', 'resuming', 'terminated']);
export type AgentSessionLifecycle = z.infer<typeof agentSessionLifecycleSchema>;

export const agentSessionConnectionSchema = z.enum(['inactive', 'connecting', 'connected', 'reconnecting']);
export type AgentSessionConnection = z.infer<typeof agentSessionConnectionSchema>;

export const agentSessionLoopPhaseSchema = z.enum([
  'waiting-provider',
  'reasoning',
  'answering',
  'using-tools',
  'awaiting-approval',
  'awaiting-user'
]);
export type AgentSessionLoopPhase = z.infer<typeof agentSessionLoopPhaseSchema>;

export const agentSessionActiveToolCallSchema = z.object({
  toolCallId: z.string().min(1),
  tool: z.string().min(1),
  startedAt: z.string()
});
export type AgentSessionActiveToolCall = z.infer<typeof agentSessionActiveToolCallSchema>;

export const agentSessionLoopSchema = z
  .object({
    state: z.enum(['idle', 'queued', 'running', 'blocked']),
    phase: agentSessionLoopPhaseSchema.optional(),
    turnId: z.string().min(1).optional(),
    pendingTurnCount: z.number().int().nonnegative(),
    enteredAt: z.string(),
    activeToolCalls: z.array(agentSessionActiveToolCallSchema)
  })
  .superRefine((loop, ctx) => {
    if (loop.state === 'idle' && loop.pendingTurnCount !== 0) {
      ctx.addIssue({ code: 'custom', path: ['pendingTurnCount'], message: 'idle loop cannot have pending turns' });
    }
    if (loop.state === 'idle' && loop.activeToolCalls.length !== 0) {
      ctx.addIssue({ code: 'custom', path: ['activeToolCalls'], message: 'idle loop cannot have active tools' });
    }
  });
export type AgentSessionLoop = z.infer<typeof agentSessionLoopSchema>;

export const agentSessionTerminationSchema = z.object({
  reason: z.enum(['completed', 'stopped', 'failed', 'deleted']),
  at: z.string(),
  error: meshAgentRuntimeFailureSchema.optional()
});
export type AgentSessionTermination = z.infer<typeof agentSessionTerminationSchema>;

export const agentSessionSnapshotSchema = z.object({
  id: z.string().min(1),
  transcriptTargetId: sessionIdSchema,
  memberInstanceId: z.string().min(1),
  runtimeId: meshSessionIdSchema.optional(),
  providerSessionRef: z.string().min(1).optional(),
  revision: z.number().int().nonnegative(),
  lifecycle: agentSessionLifecycleSchema,
  connection: agentSessionConnectionSchema,
  loop: agentSessionLoopSchema,
  termination: agentSessionTerminationSchema.optional()
});
export type AgentSessionSnapshot = z.infer<typeof agentSessionSnapshotSchema>;

export const agentSessionChangedPayloadSchema = z.object({
  memberId: z.string().min(1),
  session: agentSessionSnapshotSchema
});
export type AgentSessionChangedPayload = z.infer<typeof agentSessionChangedPayloadSchema>;
