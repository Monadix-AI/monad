import { z } from 'zod';

// Provider / product-icon are OPEN string unions (conventions.md §6): the known first-party ids give
// autocomplete + exhaustiveness hints, but a third-party `agent-adapter` atom pack may introduce a new
// provider id, so the wire schema is `z.string()` and consumers must default-handle unknown ids
// (icon/label fall back). The `KNOWN_*` tuples are the built-in set for seeding/tests.
export const KNOWN_MESH_AGENT_PROVIDERS = ['codex', 'claude-code', 'gemini', 'qwen', 'openclaw', 'hermes'] as const;
export type MeshAgentProvider = (typeof KNOWN_MESH_AGENT_PROVIDERS)[number] | (string & {});
export const meshAgentProviderSchema: z.ZodType<MeshAgentProvider> = z.string().min(1);

export const KNOWN_MESH_AGENT_PRODUCT_ICONS = ['codex', 'claude-code', 'gemini', 'qwen', 'openclaw', 'hermes'] as const;
export type MeshAgentProductIcon = (typeof KNOWN_MESH_AGENT_PRODUCT_ICONS)[number] | (string & {});
export const meshAgentProductIconSchema: z.ZodType<MeshAgentProductIcon> = z.string().min(1);

// `cli-oneshot`: the daemon spawns a fresh CLI process PER TURN with the directive baked into argv
// (e.g. `hermes -z <prompt>`), captures its stdout as the reply, and the process exits — for providers
// that have no persistent session/app-server backend. Multi-turn context is kept via the provider's
// own `--resume`/session selector. All other modes drive ONE long-lived process per session.
export const meshAgentLaunchModeSchema = z.enum(['pty', 'json-stream', 'app-server', 'cli-oneshot']);
export type MeshAgentLaunchMode = z.infer<typeof meshAgentLaunchModeSchema>;

// Byte channel between the daemon and a provider's app-server. `stdio` (newline-delimited JSON over
// the child's stdin/stdout) is the canonical embedded transport; `ws`/`unix` have the provider listen
// on a WebSocket / Unix-domain socket the daemon then dials. Only meaningful for `app-server` launches.
export const meshAgentAppServerTransportSchema = z.enum(['stdio', 'ws', 'unix']);
export type MeshAgentAppServerTransport = z.infer<typeof meshAgentAppServerTransportSchema>;

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
  settingsImport: z.boolean().optional(),
  approvalProxy: z.boolean().optional()
});
export type MeshAgentCapabilities = z.infer<typeof meshAgentCapabilitiesSchema>;

export const meshAgentProjectTemplateSchema = z.object({
  id: meshAgentNameSchema,
  displayName: meshAgentNameSchema,
  modelId: z.string().min(1).optional(),
  reasoningEffort: z.string().min(1).optional(),
  speed: z.enum(['standard', 'fast']).optional(),
  customPrompt: z.string().optional()
});
export type MeshAgentProjectTemplate = z.infer<typeof meshAgentProjectTemplateSchema>;

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

// Enforced at every parse (config load + wire), not just the HTTP upsert handler, so a hand-edited
// config.json can't smuggle a malformed command/env past the spawn path. Spawn is argv-based (no
// shell) so this is defense-in-depth, but it keeps the contract in one place.
export const meshAgentViewSchema = z
  .object({
    name: meshAgentNameSchema,
    provider: meshAgentProviderSchema,
    productIcon: meshAgentProductIconSchema.optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    modelOptions: z.array(z.string().min(1)).optional(),
    modelOptionDisplayNames: z.record(z.string(), z.string().min(1)).optional(),
    reasoningEfforts: z.array(z.string().min(1)).optional(),
    reasoningEffortsByModel: z.record(z.string(), z.array(z.string().min(1))).optional(),
    enabled: z.boolean(),
    defaultLaunchMode: meshAgentLaunchModeSchema.default('pty'),
    appServerTransport: meshAgentAppServerTransportSchema.optional(),
    allowAutopilot: z.boolean().default(true),
    approvalOwnership: meshAgentApprovalOwnershipSchema.default('provider-owned'),
    capabilities: meshAgentCapabilitiesSchema.optional(),
    projectTemplates: z.array(meshAgentProjectTemplateSchema).optional(),
    adapterSettings: meshAgentAdapterSettingsSchema.optional(),
    settings: z.array(meshAgentSettingSchema).optional()
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
export type MeshAgentView = z.infer<typeof meshAgentViewSchema>;

export const meshAgentPresetSchema = z.object({
  id: z.string(),
  label: z.string(),
  provider: meshAgentProviderSchema,
  productIcon: meshAgentProductIconSchema,
  command: z.string(),
  args: z.array(z.string()),
  modelOptions: z.array(z.string().min(1)).optional(),
  modelOptionDisplayNames: z.record(z.string(), z.string().min(1)).optional(),
  reasoningEfforts: z.array(z.string().min(1)).optional(),
  defaultLaunchMode: meshAgentLaunchModeSchema,
  supportedLaunchModes: z.array(meshAgentLaunchModeSchema),
  supportedAppServerTransports: z.array(meshAgentAppServerTransportSchema).optional(),
  installHint: z.string(),
  installUrl: z.string().url(),
  installed: z.boolean(),
  resolvedBinPath: z.string().optional(),
  capabilities: meshAgentCapabilitiesSchema.optional(),
  settings: z.array(meshAgentSettingSchema).optional()
});
export type MeshAgentPresetView = z.infer<typeof meshAgentPresetSchema>;
