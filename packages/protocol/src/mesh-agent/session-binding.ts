import { z } from 'zod';

import { iso8601Schema, meshSessionIdSchema, projectMemberIdSchema, sessionIdSchema } from '../ids.ts';
import { meshSessionStateSchema } from './mesh-session.ts';

export const sessionBindingLifecycleSchema = z.enum(['invited', 'active', 'suspended', 'left']);
export type SessionBindingLifecycle = z.infer<typeof sessionBindingLifecycleSchema>;

export const sessionBindingSchema = z
  .object({
    sessionId: sessionIdSchema,
    projectMemberId: projectMemberIdSchema,
    lastDeliveredSeq: z.number().int().nonnegative().default(0),
    lastVisibleSeq: z.number().int().nonnegative().default(0),
    currentNativeRuntimeSessionId: meshSessionIdSchema.nullable().default(null),
    lifecycle: sessionBindingLifecycleSchema.default('active'),
    lastHealth: meshSessionStateSchema.nullable().default(null),
    createdAt: iso8601Schema,
    updatedAt: iso8601Schema
  })
  .strict();
export type SessionBinding = z.infer<typeof sessionBindingSchema>;
