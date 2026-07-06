import { z } from 'zod';

// Provider / product-icon are OPEN string unions (conventions.md §6): the known first-party ids give
// autocomplete + exhaustiveness hints, but a third-party `agent-adapter` atom pack may introduce a new
// provider id, so the wire schema is `z.string()` and consumers must default-handle unknown ids
// (icon/label fall back). The `KNOWN_*` tuples are the built-in set for seeding/tests.
export const KNOWN_NATIVE_CLI_PROVIDERS = ['codex', 'claude-code', 'gemini', 'qwen', 'openclaw', 'hermes'] as const;
export type NativeCliProvider = (typeof KNOWN_NATIVE_CLI_PROVIDERS)[number] | (string & {});
export const nativeCliProviderSchema: z.ZodType<NativeCliProvider> = z.string().min(1);

export const KNOWN_NATIVE_CLI_PRODUCT_ICONS = ['codex', 'claude-code', 'gemini', 'qwen', 'openclaw', 'hermes'] as const;
export type NativeCliProductIcon = (typeof KNOWN_NATIVE_CLI_PRODUCT_ICONS)[number] | (string & {});
export const nativeCliProductIconSchema: z.ZodType<NativeCliProductIcon> = z.string().min(1);

// `cli-oneshot`: the daemon spawns a fresh CLI process PER TURN with the directive baked into argv
// (e.g. `hermes -z <prompt>`), captures its stdout as the reply, and the process exits — for providers
// that have no persistent session/app-server backend. Multi-turn context is kept via the provider's
// own `--resume`/session selector. All other modes drive ONE long-lived process per session.
export const nativeCliLaunchModeSchema = z.enum(['pty', 'json-stream', 'app-server', 'remote-control', 'cli-oneshot']);
export type NativeCliLaunchMode = z.infer<typeof nativeCliLaunchModeSchema>;

// Byte channel between the daemon and a provider's app-server. `stdio` (newline-delimited JSON over
// the child's stdin/stdout) is the canonical embedded transport; `ws`/`unix` have the provider listen
// on a WebSocket / Unix-domain socket the daemon then dials. Only meaningful for `app-server` launches.
export const nativeCliAppServerTransportSchema = z.enum(['stdio', 'ws', 'unix']);
export type NativeCliAppServerTransport = z.infer<typeof nativeCliAppServerTransportSchema>;

export const nativeCliAgentNameSchema = z
  .string()
  .min(1)
  .refine(
    (name) => name !== '.' && name !== '..' && !/[\\/:\0]/.test(name),
    'native CLI agent name must be a safe single path segment'
  );
export type NativeCliAgentName = z.infer<typeof nativeCliAgentNameSchema>;

export const nativeCliApprovalOwnershipSchema = z.literal('provider-owned');
export type NativeCliApprovalOwnership = z.infer<typeof nativeCliApprovalOwnershipSchema>;

export const nativeCliRuntimeRoleSchema = z.enum(['interactive', 'managed-project-agent']);
export type NativeCliRuntimeRole = z.infer<typeof nativeCliRuntimeRoleSchema>;

export const nativeCliAgentCapabilitiesSchema = z.object({
  auth: z.enum(['pty', 'status-probe', 'none']).default('none'),
  history: z.enum(['paged', 'provider-owned', 'none']).default('none'),
  resume: z.enum(['pty', 'structured', 'none']).default('pty'),
  approval: nativeCliApprovalOwnershipSchema.default('provider-owned'),
  settingsImport: z.boolean().optional(),
  approvalProxy: z.boolean().optional()
});
export type NativeCliAgentCapabilities = z.infer<typeof nativeCliAgentCapabilitiesSchema>;

export const nativeCliProjectTemplateSchema = z.object({
  id: nativeCliAgentNameSchema,
  displayName: nativeCliAgentNameSchema,
  modelId: z.string().min(1).optional(),
  reasoningEffort: z.string().min(1).optional(),
  speed: z.enum(['standard', 'fast']).optional(),
  customPrompt: z.string().optional()
});
export type NativeCliProjectTemplate = z.infer<typeof nativeCliProjectTemplateSchema>;

const nativeCliAgentSettingBaseSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1).optional()
});

export const nativeCliAgentSettingOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1).optional()
});
export type NativeCliAgentSettingOption = z.infer<typeof nativeCliAgentSettingOptionSchema>;

export const nativeCliAgentSettingSchema = z.discriminatedUnion('kind', [
  nativeCliAgentSettingBaseSchema.extend({
    kind: z.literal('text'),
    placeholder: z.string().optional(),
    multiline: z.boolean().optional()
  }),
  nativeCliAgentSettingBaseSchema.extend({
    kind: z.literal('switch')
  }),
  nativeCliAgentSettingBaseSchema.extend({
    kind: z.literal('select'),
    options: z.array(nativeCliAgentSettingOptionSchema).min(1),
    placeholder: z.string().optional()
  })
]);
export type NativeCliAgentSetting = z.infer<typeof nativeCliAgentSettingSchema>;

export const nativeCliAgentAdapterSettingValueSchema = z.union([z.string(), z.boolean()]);
export type NativeCliAgentAdapterSettingValue = z.infer<typeof nativeCliAgentAdapterSettingValueSchema>;
export const nativeCliAgentAdapterSettingsSchema = z.record(z.string(), nativeCliAgentAdapterSettingValueSchema);
export type NativeCliAgentAdapterSettings = z.infer<typeof nativeCliAgentAdapterSettingsSchema>;

// Enforced at every parse (config load + wire), not just the HTTP upsert handler, so a hand-edited
// config.json can't smuggle a malformed command/env past the spawn path. Spawn is argv-based (no
// shell) so this is defense-in-depth, but it keeps the contract in one place.
export const nativeCliAgentViewSchema = z
  .object({
    name: nativeCliAgentNameSchema,
    provider: nativeCliProviderSchema,
    productIcon: nativeCliProductIconSchema.optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    modelOptions: z.array(z.string().min(1)).optional(),
    reasoningEfforts: z.array(z.string().min(1)).optional(),
    reasoningEffortsByModel: z.record(z.string(), z.array(z.string().min(1))).optional(),
    enabled: z.boolean(),
    defaultLaunchMode: nativeCliLaunchModeSchema.default('pty'),
    appServerTransport: nativeCliAppServerTransportSchema.optional(),
    allowAutopilot: z.boolean().default(true),
    approvalOwnership: nativeCliApprovalOwnershipSchema.default('provider-owned'),
    capabilities: nativeCliAgentCapabilitiesSchema.optional(),
    projectTemplates: z.array(nativeCliProjectTemplateSchema).optional(),
    adapterSettings: nativeCliAgentAdapterSettingsSchema.optional(),
    settings: z.array(nativeCliAgentSettingSchema).optional()
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
export type NativeCliAgentView = z.infer<typeof nativeCliAgentViewSchema>;

export const nativeCliAgentPresetSchema = z.object({
  id: z.string(),
  label: z.string(),
  provider: nativeCliProviderSchema,
  productIcon: nativeCliProductIconSchema,
  command: z.string(),
  args: z.array(z.string()),
  modelOptions: z.array(z.string().min(1)).optional(),
  reasoningEfforts: z.array(z.string().min(1)).optional(),
  defaultLaunchMode: nativeCliLaunchModeSchema,
  supportedLaunchModes: z.array(nativeCliLaunchModeSchema),
  supportedAppServerTransports: z.array(nativeCliAppServerTransportSchema).optional(),
  installHint: z.string(),
  installUrl: z.string().url(),
  installed: z.boolean(),
  resolvedBinPath: z.string().optional(),
  capabilities: nativeCliAgentCapabilitiesSchema.optional(),
  settings: z.array(nativeCliAgentSettingSchema).optional()
});
export type NativeCliAgentPresetView = z.infer<typeof nativeCliAgentPresetSchema>;
