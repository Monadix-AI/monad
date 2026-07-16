import { absoluteUriSchema, httpUrlSchema } from '@monad/protocol';
import { z } from 'zod';

import { runtimeSchemaUrl, sourceSchemaUrl, toMonadJsonSchema } from './schema-json.ts';

export const CURRENT_AUTH_VERSION = 1;

const credentialSchema = z.object({
  id: z.string(),
  label: z.string(),
  authType: z.enum(['api_key', 'oauth', 'admin_api_key']),
  priority: z.number(),
  source: z.string(),
  accessToken: z.string(),
  baseUrl: httpUrlSchema.optional(),
  lastStatus: z.enum(['ok', 'error', 'unknown']),
  lastStatusAt: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  lastErrorReason: z.string().nullable(),
  lastErrorMessage: z.string().nullable(),
  lastErrorResetAt: z.string().nullable(),
  requestCount: z.number()
});

const channelCredentialSchema = z.object({
  token: z.string(),
  extra: z.record(z.string(), z.string()).optional()
});
export type ChannelCredential = z.infer<typeof channelCredentialSchema>;

const peerCredentialSchema = z.object({ token: z.string() });
export type PeerCredential = z.infer<typeof peerCredentialSchema>;

const mcpOAuthTokenSchema = z.object({
  clientId: z.string().optional(),
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.number().optional(),
  tokenEndpoint: httpUrlSchema,
  resource: absoluteUriSchema
});
export type McpOAuthToken = z.infer<typeof mcpOAuthTokenSchema>;

const atomRegistriesSchema = z.object({
  github: z.object({ token: z.string() }).optional(),
  npm: z.object({ token: z.string(), registry: httpUrlSchema.optional() }).optional()
});
export type AtomRegistries = z.infer<typeof atomRegistriesSchema>;

export const monadAuthSchema = z.object({
  version: z.literal(CURRENT_AUTH_VERSION),
  activeProvider: z.string().nullable(),
  updatedAt: z.string(),
  credentialPool: z.record(z.string(), z.array(credentialSchema)),
  mcpOAuth: z.record(z.string(), mcpOAuthTokenSchema).optional(),
  channelCredentials: z.record(z.string(), channelCredentialSchema).optional(),
  peerCredentials: z.record(z.string(), peerCredentialSchema).optional(),
  atomRegistries: atomRegistriesSchema.optional(),
  namedSecrets: z.record(z.string(), z.string()).optional()
});

export type MonadAuth = z.infer<typeof monadAuthSchema>;
export type Credential = z.infer<typeof credentialSchema>;

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
    activeProvider: null,
    updatedAt: new Date().toISOString(),
    credentialPool: {}
  };
}
