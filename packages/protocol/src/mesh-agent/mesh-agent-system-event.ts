import { z } from 'zod';

export const meshAgentIdleSuspendedSystemEventSchema = z
  .object({
    agentId: z.string(),
    agentName: z.string(),
    type: z.literal('idle_suspended'),
    payload: z
      .object({
        meshSessionId: z.string(),
        idleTimeoutMs: z.number().int().positive()
      })
      .strict()
  })
  .strict();
export type MeshAgentIdleSuspendedSystemEvent = z.infer<typeof meshAgentIdleSuspendedSystemEventSchema>;

export const meshAgentIdleResumedSystemEventSchema = z
  .object({
    agentId: z.string(),
    agentName: z.string(),
    type: z.literal('idle_resumed'),
    payload: z
      .object({
        meshSessionId: z.string()
      })
      .strict()
  })
  .strict();
export type MeshAgentIdleResumedSystemEvent = z.infer<typeof meshAgentIdleResumedSystemEventSchema>;

export const meshAgentSystemEventSchema = z.discriminatedUnion('type', [
  meshAgentIdleSuspendedSystemEventSchema,
  meshAgentIdleResumedSystemEventSchema
]);
export type MeshAgentSystemEvent = z.infer<typeof meshAgentSystemEventSchema>;
