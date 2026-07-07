import { z } from 'zod';

// Provider / product-icon are OPEN string unions (conventions.md §6): the known first-party ids give
// autocomplete + exhaustiveness hints, but a third-party `agent-adapter` atom pack may introduce a new
// provider id, so the wire schema is `z.string()` and consumers must default-handle unknown ids
// (icon/label fall back). The `KNOWN_*` tuples are the built-in set for seeding/tests.
export const KNOWN_EXTERNAL_AGENT_PROVIDERS = ['codex', 'claude-code', 'gemini', 'qwen', 'openclaw', 'hermes'] as const;
export type ExternalAgentProvider = (typeof KNOWN_EXTERNAL_AGENT_PROVIDERS)[number] | (string & {});
export const externalAgentProviderSchema: z.ZodType<ExternalAgentProvider> = z.string().min(1);

export const KNOWN_EXTERNAL_AGENT_PRODUCT_ICONS = [
  'codex',
  'claude-code',
  'gemini',
  'qwen',
  'openclaw',
  'hermes'
] as const;
export type ExternalAgentProductIcon = (typeof KNOWN_EXTERNAL_AGENT_PRODUCT_ICONS)[number] | (string & {});
export const externalAgentProductIconSchema: z.ZodType<ExternalAgentProductIcon> = z.string().min(1);

// `cli-oneshot`: the daemon spawns a fresh CLI process PER TURN with the directive baked into argv
// (e.g. `hermes -z <prompt>`), captures its stdout as the reply, and the process exits — for providers
// that have no persistent session/app-server backend. Multi-turn context is kept via the provider's
// own `--resume`/session selector. All other modes drive ONE long-lived process per session.
export const externalAgentLaunchModeSchema = z.enum([
  'pty',
  'json-stream',
  'app-server',
  'remote-control',
  'cli-oneshot'
]);
export type ExternalAgentLaunchMode = z.infer<typeof externalAgentLaunchModeSchema>;

// Byte channel between the daemon and a provider's app-server. `stdio` (newline-delimited JSON over
// the child's stdin/stdout) is the canonical embedded transport; `ws`/`unix` have the provider listen
// on a WebSocket / Unix-domain socket the daemon then dials. Only meaningful for `app-server` launches.
export const externalAgentAppServerTransportSchema = z.enum(['stdio', 'ws', 'unix']);
export type ExternalAgentAppServerTransport = z.infer<typeof externalAgentAppServerTransportSchema>;

export const externalAgentNameSchema = z
  .string()
  .min(1)
  .refine(
    (name) => name !== '.' && name !== '..' && !/[\\/:\0]/.test(name),
    'external agent name must be a safe single path segment'
  );
export type ExternalAgentName = z.infer<typeof externalAgentNameSchema>;

export const externalAgentApprovalOwnershipSchema = z.literal('provider-owned');
export type ExternalAgentApprovalOwnership = z.infer<typeof externalAgentApprovalOwnershipSchema>;

export const externalAgentRuntimeRoleSchema = z.enum(['interactive', 'managed-project-agent']);
export type ExternalAgentRuntimeRole = z.infer<typeof externalAgentRuntimeRoleSchema>;

export const externalAgentCapabilitiesSchema = z.object({
  auth: z.enum(['pty', 'status-probe', 'none']).default('none'),
  history: z.enum(['paged', 'provider-owned', 'none']).default('none'),
  resume: z.enum(['pty', 'structured', 'none']).default('pty'),
  approval: externalAgentApprovalOwnershipSchema.default('provider-owned'),
  settingsImport: z.boolean().optional(),
  approvalProxy: z.boolean().optional()
});
export type ExternalAgentCapabilities = z.infer<typeof externalAgentCapabilitiesSchema>;

export const externalAgentProjectTemplateSchema = z.object({
  id: externalAgentNameSchema,
  displayName: externalAgentNameSchema,
  modelId: z.string().min(1).optional(),
  reasoningEffort: z.string().min(1).optional(),
  speed: z.enum(['standard', 'fast']).optional(),
  customPrompt: z.string().optional()
});
export type ExternalAgentProjectTemplate = z.infer<typeof externalAgentProjectTemplateSchema>;

const externalAgentSettingBaseSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1).optional()
});

export const externalAgentSettingOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1).optional()
});
export type ExternalAgentSettingOption = z.infer<typeof externalAgentSettingOptionSchema>;

export const externalAgentSettingSchema = z.discriminatedUnion('kind', [
  externalAgentSettingBaseSchema.extend({
    kind: z.literal('text'),
    placeholder: z.string().optional(),
    multiline: z.boolean().optional()
  }),
  externalAgentSettingBaseSchema.extend({
    kind: z.literal('switch')
  }),
  externalAgentSettingBaseSchema.extend({
    kind: z.literal('select'),
    options: z.array(externalAgentSettingOptionSchema).min(1),
    placeholder: z.string().optional()
  })
]);
export type ExternalAgentSetting = z.infer<typeof externalAgentSettingSchema>;

export const externalAgentAdapterSettingValueSchema = z.union([z.string(), z.boolean()]);
export type ExternalAgentAdapterSettingValue = z.infer<typeof externalAgentAdapterSettingValueSchema>;
export const externalAgentAdapterSettingsSchema = z.record(z.string(), externalAgentAdapterSettingValueSchema);
export type ExternalAgentAdapterSettings = z.infer<typeof externalAgentAdapterSettingsSchema>;

// Enforced at every parse (config load + wire), not just the HTTP upsert handler, so a hand-edited
// config.json can't smuggle a malformed command/env past the spawn path. Spawn is argv-based (no
// shell) so this is defense-in-depth, but it keeps the contract in one place.
export const externalAgentViewSchema = z
  .object({
    name: externalAgentNameSchema,
    provider: externalAgentProviderSchema,
    productIcon: externalAgentProductIconSchema.optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    modelOptions: z.array(z.string().min(1)).optional(),
    reasoningEfforts: z.array(z.string().min(1)).optional(),
    reasoningEffortsByModel: z.record(z.string(), z.array(z.string().min(1))).optional(),
    enabled: z.boolean(),
    defaultLaunchMode: externalAgentLaunchModeSchema.default('pty'),
    appServerTransport: externalAgentAppServerTransportSchema.optional(),
    allowAutopilot: z.boolean().default(true),
    approvalOwnership: externalAgentApprovalOwnershipSchema.default('provider-owned'),
    capabilities: externalAgentCapabilitiesSchema.optional(),
    projectTemplates: z.array(externalAgentProjectTemplateSchema).optional(),
    adapterSettings: externalAgentAdapterSettingsSchema.optional(),
    settings: z.array(externalAgentSettingSchema).optional()
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
export type ExternalAgentView = z.infer<typeof externalAgentViewSchema>;

export const externalAgentPresetSchema = z.object({
  id: z.string(),
  label: z.string(),
  provider: externalAgentProviderSchema,
  productIcon: externalAgentProductIconSchema,
  command: z.string(),
  args: z.array(z.string()),
  modelOptions: z.array(z.string().min(1)).optional(),
  reasoningEfforts: z.array(z.string().min(1)).optional(),
  defaultLaunchMode: externalAgentLaunchModeSchema,
  supportedLaunchModes: z.array(externalAgentLaunchModeSchema),
  supportedAppServerTransports: z.array(externalAgentAppServerTransportSchema).optional(),
  installHint: z.string(),
  installUrl: z.string().url(),
  installed: z.boolean(),
  resolvedBinPath: z.string().optional(),
  capabilities: externalAgentCapabilitiesSchema.optional(),
  settings: z.array(externalAgentSettingSchema).optional()
});
export type ExternalAgentPresetView = z.infer<typeof externalAgentPresetSchema>;
