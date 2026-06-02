import { z } from 'zod';

import { agentIdSchema } from './ids.ts';

export const agentCredentialEnvironmentVariableSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

function normalizeHostname(value: string): string {
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export const agentCredentialHostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .transform((value, ctx) => {
    if (
      value.includes('*') ||
      value.includes('://') ||
      /[/\\@?#%:\s]/.test(value) ||
      value.startsWith('.') ||
      value.endsWith('.')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'expected a hostname without scheme, port, path, user-info, or wildcard'
      });
      return z.NEVER;
    }
    const hostname = normalizeHostname(value);
    if (
      !hostname ||
      hostname.length > 253 ||
      /^[0-9.]+$/.test(hostname) ||
      /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(hostname) ||
      hostname.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    ) {
      ctx.addIssue({ code: 'custom', message: 'expected a valid DNS hostname' });
      return z.NEVER;
    }
    return hostname;
  });

export const agentCredentialViewSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    description: z.string().optional(),
    environmentVariable: z.string(),
    allowedHosts: z.array(z.string()),
    configured: z.boolean(),
    authorizedAgentIds: z.array(agentIdSchema)
  })
  .strict();
export type AgentCredentialView = z.infer<typeof agentCredentialViewSchema>;

export const agentCredentialSecretUpdateSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('replace'), value: z.string().min(1) }).strict(),
  z.object({ action: z.literal('remove') }).strict()
]);
export type AgentCredentialSecretUpdate = z.infer<typeof agentCredentialSecretUpdateSchema>;

const agentCredentialMetadataSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).optional(),
    environmentVariable: agentCredentialEnvironmentVariableSchema,
    allowedHosts: z.array(agentCredentialHostSchema).min(1).max(64)
  })
  .strict();

export const createAgentCredentialRequestSchema = agentCredentialMetadataSchema
  .extend({ secret: z.string().min(1) })
  .strict();
export type CreateAgentCredentialRequest = z.infer<typeof createAgentCredentialRequestSchema>;

export const updateAgentCredentialRequestSchema = agentCredentialMetadataSchema
  .partial()
  .extend({ secret: agentCredentialSecretUpdateSchema.optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'at least one credential field is required');
export type UpdateAgentCredentialRequest = z.infer<typeof updateAgentCredentialRequestSchema>;

export const listAgentCredentialsResponseSchema = z
  .object({ credentials: z.array(agentCredentialViewSchema) })
  .strict();
export type ListAgentCredentialsResponse = z.infer<typeof listAgentCredentialsResponseSchema>;

export const getAgentCredentialResponseSchema = z.object({ credential: agentCredentialViewSchema }).strict();
export type GetAgentCredentialResponse = z.infer<typeof getAgentCredentialResponseSchema>;

export const createAgentCredentialResponseSchema = getAgentCredentialResponseSchema;
export type CreateAgentCredentialResponse = z.infer<typeof createAgentCredentialResponseSchema>;

export const updateAgentCredentialResponseSchema = getAgentCredentialResponseSchema;
export type UpdateAgentCredentialResponse = z.infer<typeof updateAgentCredentialResponseSchema>;

export const deleteAgentCredentialResponseSchema = z
  .object({
    ok: z.literal(true),
    affectedAgentIds: z.array(agentIdSchema)
  })
  .strict();
export type DeleteAgentCredentialResponse = z.infer<typeof deleteAgentCredentialResponseSchema>;

export const agentCredentialCapabilitySchema = z
  .object({
    available: z.boolean(),
    code: z.literal('protected_execution_unavailable').optional()
  })
  .strict();
export type AgentCredentialCapability = z.infer<typeof agentCredentialCapabilitySchema>;

export const agentCredentialErrorResponseSchema = z.discriminatedUnion('code', [
  z
    .object({
      error: z.literal('agent_credential_not_found'),
      code: z.literal('agent_credential_not_found'),
      params: z.object({ credentialId: z.string() }).strict()
    })
    .strict(),
  z
    .object({
      error: z.literal('agent_credential_environment_variable_conflict'),
      code: z.literal('agent_credential_environment_variable_conflict'),
      params: z.object({ environmentVariable: agentCredentialEnvironmentVariableSchema }).strict()
    })
    .strict()
]);
export type AgentCredentialErrorResponse = z.infer<typeof agentCredentialErrorResponseSchema>;
