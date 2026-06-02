import { agentCredentialEnvironmentVariableSchema, agentCredentialHostSchema } from '@monad/protocol';
import { z } from 'zod';

import { runtimeSchemaUrl, sourceSchemaUrl, toMonadJsonSchema } from './schema-json.ts';

export const CURRENT_AUTH_VERSION = 1;

export const agentCredentialSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).optional(),
    environmentVariable: agentCredentialEnvironmentVariableSchema,
    secret: z.string().min(1).optional(),
    allowedHosts: z.array(agentCredentialHostSchema).min(1).max(64),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();

export const monadAuthSchema = z
  .object({
    version: z.literal(CURRENT_AUTH_VERSION),
    updatedAt: z.string().datetime(),
    credentials: z.record(z.string().min(1), agentCredentialSchema)
  })
  .strict();

export type MonadAuth = z.infer<typeof monadAuthSchema>;
export type AgentCredential = z.infer<typeof agentCredentialSchema>;

let authSchemaUrl = sourceSchemaUrl('auth');

export const AUTH_SCHEMA_CONTENT = toMonadJsonSchema(monadAuthSchema);

export function getAuthSchemaUrl(): string {
  return authSchemaUrl;
}

export function setAuthSchemaRuntimeDir(runtimeDir: string): void {
  if (Bun.env.NODE_ENV !== 'development') authSchemaUrl = runtimeSchemaUrl(runtimeDir, 'auth');
}

export function emptyAuth(): MonadAuth {
  return {
    version: CURRENT_AUTH_VERSION,
    updatedAt: new Date().toISOString(),
    credentials: {}
  };
}
