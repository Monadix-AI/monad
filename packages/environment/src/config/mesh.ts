import {
  absoluteUriSchema,
  httpUrlSchema,
  meshAgentAdapterSettingsSchema,
  meshAgentApprovalOwnershipSchema,
  meshAgentDiscoverySchema,
  meshAgentNameSchema,
  meshAgentProviderSchema,
  peerIdSchema
} from '@monad/protocol';
import { z } from 'zod';

import { runtimeSchemaUrl, sourceSchemaUrl, toMonadJsonSchema } from './schema-json.ts';

export const CURRENT_MESH_VERSION = 1;

export const acpAgentSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  enabled: z.boolean().default(true),
  osSandbox: z.boolean().default(false),
  forwardMcp: z.boolean().default(false)
});
export type AcpAgentConfig = z.infer<typeof acpAgentSchema>;

export const meshAgentSchema = z
  .object({
    name: meshAgentNameSchema,
    displayName: z.string().min(1).optional(),
    provider: meshAgentProviderSchema,
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean(),
    allowAutopilot: z.boolean().default(true),
    approvalOwnership: meshAgentApprovalOwnershipSchema.default('provider-owned'),
    adapterSettings: meshAgentAdapterSettingsSchema.optional(),
    discovery: meshAgentDiscoverySchema.optional()
  })
  .superRefine((agent, ctx) => {
    if (/\s/.test(agent.command)) {
      ctx.addIssue({
        code: 'custom',
        path: ['command'],
        message: 'command must be a binary path or name; use args for flags'
      });
    }
    if (/[;&|`$<>(){}[\]*?]/.test(agent.command)) {
      ctx.addIssue({ code: 'custom', path: ['command'], message: 'command contains unsupported shell metacharacters' });
    }
    for (const [key, value] of Object.entries(agent.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        ctx.addIssue({ code: 'custom', path: ['env', key], message: `env key "${key}" is invalid` });
      }
      if (value.includes('\0')) {
        ctx.addIssue({ code: 'custom', path: ['env', key], message: `env value for "${key}" must not contain NUL` });
      }
    }
  });
export type MeshAgentConfig = z.infer<typeof meshAgentSchema>;

export const monadixConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    baseUrl: httpUrlSchema.optional(),
    flow: z.enum(['loopback', 'device']).optional(),
    autoApproveReadOnly: z.boolean().optional(),
    supabaseUrl: httpUrlSchema.optional(),
    supabaseAnonKey: z.string().optional(),
    oauth: z
      .object({
        clientId: z.string().optional(),
        accessToken: z.string(),
        refreshToken: z.string().optional(),
        expiresAt: z.number().optional(),
        tokenEndpoint: httpUrlSchema,
        resource: absoluteUriSchema
      })
      .strict()
      .optional()
  })
  .default({ enabled: false });
export type MonadixConfig = z.infer<typeof monadixConfigSchema>;

export const peerSchema = z
  .object({
    id: peerIdSchema,
    label: z.string().min(1),
    baseUrl: httpUrlSchema,
    defaultAgent: z.string().default('default'),
    credential: z
      .object({
        token: z
          .string()
          .min(1)
          .refine((value) => !value.startsWith('${secret:'), {
            message: 'peer credential token must be stored directly'
          })
      })
      .strict()
      .optional(),
    enabled: z.boolean().default(false)
  })
  .strict();
export type PeerConfig = z.infer<typeof peerSchema>;

export const monadMeshConfigSchema = z.object({
  version: z.literal(CURRENT_MESH_VERSION),
  acpAgents: z.array(acpAgentSchema).default([]),
  meshAgents: z.array(meshAgentSchema).default([]),
  peers: z.array(peerSchema).default([]),
  monadix: monadixConfigSchema
});
export type MonadMeshConfig = z.infer<typeof monadMeshConfigSchema>;

let meshSchemaUrl = sourceSchemaUrl('mesh');

export const MESH_SCHEMA_CONTENT = toMonadJsonSchema(monadMeshConfigSchema);

export function getMeshSchemaUrl(): string {
  return meshSchemaUrl;
}

export function setMeshSchemaRuntimeDir(runtimeDir: string): void {
  if (Bun.env.NODE_ENV !== 'development') meshSchemaUrl = runtimeSchemaUrl(runtimeDir, 'mesh');
}
