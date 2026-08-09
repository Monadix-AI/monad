import { z } from 'zod';

const meshAgentNamedSystemEventSchema = z.object({
  agentId: z.string(),
  agentName: z.string()
});

export const meshAgentIdleSuspendedSystemEventVariantSchema = meshAgentNamedSystemEventSchema
  .extend({
    type: z.literal('idle_suspended'),
    payload: z
      .object({
        meshSessionId: z.string(),
        idleTimeoutMs: z.number().int().positive()
      })
      .strict()
  })
  .strict();

export const meshAgentIdleResumedSystemEventVariantSchema = meshAgentNamedSystemEventSchema
  .extend({
    type: z.literal('idle_resumed'),
    payload: z
      .object({
        meshSessionId: z.string()
      })
      .strict()
  })
  .strict();

const meshAgentTerminalSystemEventSchema = meshAgentNamedSystemEventSchema.extend({
  payload: z
    .object({
      meshSessionId: z.string(),
      exitCode: z.number().int().nullable()
    })
    .strict()
});

export const meshAgentSystemEventSchema = z.discriminatedUnion('type', [
  meshAgentIdleSuspendedSystemEventVariantSchema,
  meshAgentIdleResumedSystemEventVariantSchema,
  meshAgentNamedSystemEventSchema
    .extend({
      type: z.literal('resume_failed'),
      payload: z
        .object({
          provider: z.string(),
          providerSessionRef: z.string()
        })
        .strict()
    })
    .strict(),
  meshAgentNamedSystemEventSchema
    .extend({
      type: z.literal('connection_required'),
      payload: z
        .object({
          meshSessionId: z.string().optional()
        })
        .strict()
    })
    .strict(),
  meshAgentTerminalSystemEventSchema.extend({ type: z.literal('exited') }).strict(),
  meshAgentTerminalSystemEventSchema.extend({ type: z.literal('failed') }).strict(),
  meshAgentTerminalSystemEventSchema.extend({ type: z.literal('stopped') }).strict()
]);
export type MeshAgentSystemEvent = z.infer<typeof meshAgentSystemEventSchema>;
