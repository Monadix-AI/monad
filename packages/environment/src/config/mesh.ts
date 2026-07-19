import type { MonadAuth } from './auth.ts';

import {
  httpUrlSchema,
  meshAgentAdapterSettingsSchema,
  meshAgentApprovalOwnershipSchema,
  meshAgentAppServerTransportSchema,
  meshAgentNameSchema,
  meshAgentProjectTemplateSchema,
  meshAgentProviderSchema,
  peerIdSchema
} from '@monad/protocol';
import { z } from 'zod';

import { matchEnvRef } from '../secret-ref.ts';
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
    provider: meshAgentProviderSchema,
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean(),
    appServerTransport: meshAgentAppServerTransportSchema.optional(),
    allowAutopilot: z.boolean().default(true),
    approvalOwnership: meshAgentApprovalOwnershipSchema.default('provider-owned'),
    projectTemplates: z.array(meshAgentProjectTemplateSchema).optional(),
    adapterSettings: meshAgentAdapterSettingsSchema.optional()
  })
  .superRefine((agent, ctx) => {
    const projectTemplateIds = new Set<string>();
    for (const [index, template] of (agent.projectTemplates ?? []).entries()) {
      if (projectTemplateIds.has(template.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['projectTemplates', index, 'id'],
          message: `project template id "${template.id}" must be unique`
        });
      }
      projectTemplateIds.add(template.id);
    }
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
    supabaseAnonKey: z.string().optional()
  })
  .default({ enabled: false });
export type MonadixConfig = z.infer<typeof monadixConfigSchema>;

export function resolvePeerSecretRef(ref: string, auth: MonadAuth): string {
  const envRef = matchEnvRef(ref);
  if (envRef) {
    const key = envRef[1] as string;
    const resolved = Bun.env[key];
    if (resolved === undefined) throw new Error(`peer token "${ref}" is unset (env ${key} not defined)`);
    return resolved;
  }
  const secretRef = ref.match(/^\$\{secret:peer\/([^/]+)\/token\}$/);
  if (secretRef) {
    const id = secretRef[1] as string;
    const token = auth.peerCredentials?.[id]?.token;
    if (!token) throw new Error(`peer token "${ref}" is unset (no auth.json credential for peer ${id})`);
    return token;
  }
  return ref;
}

export const peerSchema = z.object({
  id: peerIdSchema,
  label: z.string().min(1),
  baseUrl: httpUrlSchema,
  defaultAgent: z.string().default('default'),
  tokenRef: z.string(),
  enabled: z.boolean().default(false)
});
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
