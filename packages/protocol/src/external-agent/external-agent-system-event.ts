import { z } from 'zod';

export const externalAgentIdleSuspendedSystemEventSchema = z
  .object({
    agentId: z.string(),
    agentName: z.string(),
    type: z.literal('idle_suspended'),
    payload: z
      .object({
        externalAgentSessionId: z.string(),
        idleTimeoutMs: z.number()
      })
      .strict()
  })
  .strict();
export type ExternalAgentIdleSuspendedSystemEvent = z.infer<typeof externalAgentIdleSuspendedSystemEventSchema>;

export const externalAgentIdleResumedSystemEventSchema = z
  .object({
    agentId: z.string(),
    agentName: z.string(),
    type: z.literal('idle_resumed'),
    payload: z
      .object({
        externalAgentSessionId: z.string()
      })
      .strict()
  })
  .strict();
export type ExternalAgentIdleResumedSystemEvent = z.infer<typeof externalAgentIdleResumedSystemEventSchema>;

export const externalAgentSystemEventSchema = z.discriminatedUnion('type', [
  externalAgentIdleSuspendedSystemEventSchema,
  externalAgentIdleResumedSystemEventSchema
]);
export type ExternalAgentSystemEvent = z.infer<typeof externalAgentSystemEventSchema>;
