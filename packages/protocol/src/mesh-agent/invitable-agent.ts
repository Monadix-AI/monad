import { z } from 'zod';

import {
  meshAgentCapabilitiesSchema,
  meshAgentNameSchema,
  meshAgentProductIconSchema,
  meshAgentProviderSchema,
  meshAgentSettingSchema
} from './mesh-agent-config.ts';

export const invitableMeshAgentSchema = z
  .object({
    name: meshAgentNameSchema,
    displayName: z.string().min(1).optional(),
    provider: meshAgentProviderSchema,
    productIcon: meshAgentProductIconSchema.optional(),
    enabled: z.boolean(),
    allowAutopilot: z.boolean().default(true),
    capabilities: meshAgentCapabilitiesSchema.optional(),
    modelOptions: z.array(z.string().min(1)).optional(),
    modelOptionDisplayNames: z.record(z.string(), z.string().min(1)).optional(),
    speedsByModel: z.record(z.string(), z.array(z.string().min(1))).optional(),
    reasoningEfforts: z.array(z.string().min(1)).optional(),
    reasoningEffortsByModel: z.record(z.string(), z.array(z.string().min(1))).optional(),
    settings: z.array(meshAgentSettingSchema).optional(),
    source: z.enum(['configured-mesh-agent', 'monad-agent'])
  })
  .strict();
export type InvitableMeshAgent = z.infer<typeof invitableMeshAgentSchema>;

export const listInvitableMeshAgentsResponseSchema = z
  .object({
    agents: z.array(invitableMeshAgentSchema)
  })
  .strict();
export type ListInvitableMeshAgentsResponse = z.infer<typeof listInvitableMeshAgentsResponseSchema>;
