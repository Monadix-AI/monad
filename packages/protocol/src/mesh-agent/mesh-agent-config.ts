import { z } from 'zod';

import { channelIconSchema } from '../channel.ts';

// Provider / product-icon are OPEN string unions (conventions.md §6): the known first-party ids give
// autocomplete + exhaustiveness hints, but a third-party `agent-adapter` atom pack may introduce a new
// provider id, so the wire schema is `z.string()` and consumers must default-handle unknown ids
// (icon/label fall back). The `KNOWN_*` tuples are the built-in set for seeding/tests.
export const KNOWN_MESH_AGENT_PROVIDERS = [
  'codex',
  'claude-code',
  'gemini',
  'antigravity',
  'qwen',
  'openclaw',
  'hermes',
  'monad'
] as const;
export type MeshAgentProvider = (typeof KNOWN_MESH_AGENT_PROVIDERS)[number] | (string & {});
export const meshAgentProviderSchema: z.ZodType<MeshAgentProvider> = z.string().min(1);

export const KNOWN_MESH_AGENT_PRODUCT_ICONS = [
  'codex',
  'claude-code',
  'gemini',
  'antigravity',
  'qwen',
  'openclaw',
  'hermes',
  'monad'
] as const;
export type MeshAgentProductIcon = (typeof KNOWN_MESH_AGENT_PRODUCT_ICONS)[number] | (string & {});
export const meshAgentProductIconSchema: z.ZodType<MeshAgentProductIcon> = z.string().min(1);

export const meshAgentNameSchema = z
  .string()
  .min(1)
  .refine(
    (name) => name !== '.' && name !== '..' && !/[\\/:\0]/.test(name),
    'MeshAgent name must be a safe single path segment'
  );
export type MeshAgentName = z.infer<typeof meshAgentNameSchema>;

export const meshAgentApprovalOwnershipSchema = z.literal('provider-owned');
export type MeshAgentApprovalOwnership = z.infer<typeof meshAgentApprovalOwnershipSchema>;

export const meshAgentRuntimeRoleSchema = z.enum(['interactive', 'managed-project-agent']);
export type MeshAgentRuntimeRole = z.infer<typeof meshAgentRuntimeRoleSchema>;

export const meshAgentCapabilitiesSchema = z.object({
  auth: z.enum(['pty', 'status-probe', 'none']).default('none'),
  events: z.enum(['paged', 'provider-owned', 'none']).default('none'),
  resume: z.enum(['pty', 'structured', 'none']).default('pty'),
  approval: meshAgentApprovalOwnershipSchema.default('provider-owned'),
  autopilot: z.boolean().optional(),
  fastMode: z.boolean().optional(),
  settingsImport: z.boolean().optional(),
  approvalProxy: z.boolean().optional(),
  // `hosted` providers own long-lived agent instances an operator picks from; `spawned` providers
  // create a fresh process per member. Absent means `spawned`.
  agentInstances: z.enum(['hosted', 'spawned']).optional()
});
export type MeshAgentCapabilities = z.infer<typeof meshAgentCapabilitiesSchema>;

const meshAgentSettingBaseSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1).optional()
});

export const meshAgentSettingOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1).optional()
});
export type MeshAgentSettingOption = z.infer<typeof meshAgentSettingOptionSchema>;

export const meshAgentSettingSchema = z.discriminatedUnion('kind', [
  meshAgentSettingBaseSchema.extend({
    kind: z.literal('text'),
    placeholder: z.string().optional(),
    multiline: z.boolean().optional()
  }),
  meshAgentSettingBaseSchema.extend({
    kind: z.literal('switch')
  }),
  meshAgentSettingBaseSchema.extend({
    kind: z.literal('select'),
    options: z.array(meshAgentSettingOptionSchema).min(1),
    placeholder: z.string().optional()
  })
]);
export type MeshAgentSetting = z.infer<typeof meshAgentSettingSchema>;

export const meshAgentAdapterSettingValueSchema = z.union([z.string(), z.boolean()]);
export type MeshAgentAdapterSettingValue = z.infer<typeof meshAgentAdapterSettingValueSchema>;
export const meshAgentAdapterSettingsSchema = z.record(z.string(), meshAgentAdapterSettingValueSchema);
export type MeshAgentAdapterSettings = z.infer<typeof meshAgentAdapterSettingsSchema>;

export const meshAgentDiscoverySchema = z.object({
  connectorName: meshAgentNameSchema,
  externalId: meshAgentNameSchema,
  state: z.enum(['available', 'missing'])
});
export type MeshAgentDiscovery = z.infer<typeof meshAgentDiscoverySchema>;

// Enforced at every parse (config load + wire), not just the HTTP upsert handler, so a hand-edited
// config.json can't smuggle a malformed command/env past the spawn path. Spawn is argv-based (no
// shell) so this is defense-in-depth, but it keeps the contract in one place.
export const meshAgentViewSchema = z
  .object({
    name: meshAgentNameSchema,
    displayName: z.string().min(1).optional(),
    provider: meshAgentProviderSchema,
    productIcon: meshAgentProductIconSchema.optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    modelOptions: z.array(z.string().min(1)).optional(),
    modelOptionDisplayNames: z.record(z.string(), z.string().min(1)).optional(),
    speedsByModel: z.record(z.string(), z.array(z.string().min(1))).optional(),
    reasoningEfforts: z.array(z.string().min(1)).optional(),
    reasoningEffortsByModel: z.record(z.string(), z.array(z.string().min(1))).optional(),
    enabled: z.boolean(),
    allowAutopilot: z.boolean().default(true),
    approvalOwnership: meshAgentApprovalOwnershipSchema.default('provider-owned'),
    capabilities: meshAgentCapabilitiesSchema.optional(),
    adapterSettings: meshAgentAdapterSettingsSchema.optional(),
    discovery: meshAgentDiscoverySchema.optional(),
    settings: z.array(meshAgentSettingSchema).optional()
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
export type MeshAgentView = z.infer<typeof meshAgentViewSchema>;

export const meshAgentPresetSchema = z.object({
  id: z.string(),
  label: z.string(),
  provider: meshAgentProviderSchema,
  productIcon: meshAgentProductIconSchema,
  icon: channelIconSchema.optional(),
  command: z.string(),
  args: z.array(z.string()),
  modelOptions: z.array(z.string().min(1)).optional(),
  modelOptionDisplayNames: z.record(z.string(), z.string().min(1)).optional(),
  speedsByModel: z.record(z.string(), z.array(z.string().min(1))).optional(),
  reasoningEfforts: z.array(z.string().min(1)).optional(),
  installHint: z.string(),
  installUrl: z.string().url(),
  installed: z.boolean(),
  resolvedBinPath: z.string().optional(),
  capabilities: meshAgentCapabilitiesSchema.optional(),
  settings: z.array(meshAgentSettingSchema).optional()
});
export type MeshAgentPresetView = z.infer<typeof meshAgentPresetSchema>;
