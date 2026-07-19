import {
  avatarStyleSchema,
  blankableHttpUrlSchema,
  channelAllowlistSchema,
  channelGroupPolicySchema,
  channelIdSchema,
  channelTypeSchema,
  composerSettingsSchema,
  DEFAULT_AVATAR_STYLE,
  DEFAULT_COMPOSER_SETTINGS,
  ModelProviderType,
  KNOWN_PROVIDER_TYPES as PROTOCOL_KNOWN_PROVIDER_TYPES,
  userAvatarDataUrlSchema
} from '@monad/protocol';

// GenerationParams / FallbackTarget are owned by @monad/protocol (single source). home keeps its
// own stricter parse schema for GenerationParams (disk-boundary bounds) but derives the type.
export type { FallbackTargetView as FallbackTarget, GenerationParams, SandboxMode } from '@monad/protocol';

// sandboxModeSchema is owned by @monad/protocol (single source of truth); re-export so existing
// `@monad/environment` importers (apps/monad, sdk-atom) keep their import path.
export { sandboxModeSchema } from '@monad/protocol';

import { z } from 'zod';

export type { ModelProviderType } from '@monad/protocol';

export { PROTOCOL_KNOWN_PROVIDER_TYPES as KNOWN_PROVIDER_TYPES };

import {
  DEFAULT_SAMPLE_PROFILE_ALIAS,
  DEFAULT_SAMPLE_PROVIDER_ID,
  monadAgentsConfigSchema,
  setAgentsSchemaRuntimeDir
} from './agents.ts';
import { setAuthSchemaRuntimeDir } from './auth.ts';
import { monadMeshConfigSchema, setMeshSchemaRuntimeDir } from './mesh.ts';
import { runtimeSchemaUrl, sourceSchemaUrl, toMonadJsonSchema } from './schema-json.ts';

// Pre-release: the full schema is a single v1 entry — edit it freely instead of writing
// incremental migrations. When the schema changes post-release: bump the constant, update the
// schema below, drop a new vN.ts in the matching migrations/ subdirectory, and add a test fixture.
export const CURRENT_CONFIG_VERSION = 1;

let configSchemaUrl = sourceSchemaUrl('config');

export function setSchemaRuntimeDir(runtimeDir: string): void {
  if (Bun.env.NODE_ENV === 'development') return;
  configSchemaUrl = runtimeSchemaUrl(runtimeDir, 'config');
  setAgentsSchemaRuntimeDir(runtimeDir);
  setMeshSchemaRuntimeDir(runtimeDir);
  setAuthSchemaRuntimeDir(runtimeDir);
}

export function getConfigSchemaUrl(): string {
  return configSchemaUrl;
}

/**
 * Default LOCAL REST/SSE client transport — `uds` on every platform, overridable via
 * `network.transport` in config.json. Bun supports AF_UNIX everywhere monad targets (Windows too,
 * native since Win10), the daemon binds the socket on all of them, and a Unix socket is browser-safe
 * (a page can reach `127.0.0.1` but not an AF_UNIX path) — so it's the better local default. If the
 * socket ever can't be dialled the client falls back to TCP at connect time (see makeUnixFetcher).
 *
 * The daemon always serves TCP as well (WS push is TCP-only — Bun's WebSocket client has no
 * unix-socket option — and the web UI needs a port), so this only picks the CLI's REST/SSE path.
 */
export const DEFAULT_TRANSPORT = 'uds' as const;
export const DEFAULT_LOCAL_HTTP_FALLBACK_PORT = 47780;

export const moConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    binaryPath: z.string().optional()
  })
  .default({ enabled: true });
export type MoConfig = z.infer<typeof moConfigSchema>;

export const channelInstanceSchema = z.object({
  id: channelIdSchema,
  type: channelTypeSchema,
  label: z.string().min(1),
  enabled: z.boolean().default(true),
  agentId: z.string().optional(),
  options: z.record(z.string(), z.unknown()).default({}),
  allowlist: channelAllowlistSchema.default({ allowAllUsers: false, allowedUsers: [] }),
  groupPolicy: channelGroupPolicySchema.optional(),
  agentHint: z.string().max(2000).optional(),
  mapping: z
    .object({
      granularity: z.enum(['per-conversation', 'per-thread', 'per-user']).default('per-conversation'),
      reset: z.object({ idleMinutes: z.number().int().positive().optional(), daily: z.boolean().optional() }).optional()
    })
    .default({ granularity: 'per-conversation' }),
  tokenRef: z.string(),
  rateLimitPerMin: z.number().int().positive().default(20)
});
export type ChannelInstanceConfig = z.infer<typeof channelInstanceSchema>;

const localHttpFallbackSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().min(1).max(65535).default(DEFAULT_LOCAL_HTTP_FALLBACK_PORT)
});

const httpsSchema = z.object({
  enabled: z.boolean().default(false)
});

const networkConfigSchema = z
  .object({
    port: z.number().int().min(1).max(65535).default(47749),
    host: z.string().min(1).default('127.0.0.1'),
    // Which socket the LOCAL client dials — daemon always serves both; WS push is always TCP.
    transport: z.enum(['tcp', 'uds']).default(DEFAULT_TRANSPORT),
    // HTTPS is independent from remote access. Remote-access enable flows opt into it by default.
    https: httpsSchema.default({ enabled: false }),
    remoteAccess: z.object({
      // When true, daemon binds the primary TCP listener to 0.0.0.0 and requires a Bearer token remotely.
      enabled: z.boolean(),
      token: z.string().nullable()
    }),
    // Optional compatibility listener for old local clients and debugging. Always loopback-only.
    localHttpFallback: localHttpFallbackSchema.default({
      enabled: false,
      port: DEFAULT_LOCAL_HTTP_FALLBACK_PORT
    })
  })
  .default(() => ({
    port: 47749,
    host: '127.0.0.1',
    transport: DEFAULT_TRANSPORT,
    https: { enabled: false },
    remoteAccess: { enabled: false, token: null },
    localHttpFallback: { enabled: false, port: DEFAULT_LOCAL_HTTP_FALLBACK_PORT }
  }));

const observabilityConfigSchema = z
  .object({
    // OTLP HTTP endpoint for traces + metrics. Leave empty to disable.
    // Developer Mode auto-defaults the endpoint to http://localhost:6006 unless this is set.
    endpoint: blankableHttpUrlSchema.default('')
  })
  .default({ endpoint: '' });

function defaultDeveloperMode(): boolean {
  return Bun.env.NODE_ENV === 'development';
}

export const monadSystemConfigSchema = z.object({
  version: z.literal(CURRENT_CONFIG_VERSION),
  developerMode: z.boolean().default(defaultDeveloperMode),
  user: z
    .object({
      displayName: z.string().default('User'),
      avatarDataUrl: userAvatarDataUrlSchema.nullable().default(null)
    })
    .default({ displayName: 'User', avatarDataUrl: null }),
  appearance: z
    .object({
      avatarStyle: avatarStyleSchema.default(DEFAULT_AVATAR_STYLE),
      composer: composerSettingsSchema
    })
    .default({ avatarStyle: DEFAULT_AVATAR_STYLE, composer: DEFAULT_COMPOSER_SETTINGS }),
  network: networkConfigSchema,
  channels: z.array(channelInstanceSchema).default([]),
  mo: moConfigSchema,
  locale: z.string().default('en'),
  atomPins: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  observability: observabilityConfigSchema,
  openaiCompat: z
    .object({
      enabled: z.boolean().default(false),
      token: z.string().optional(),
      approval: z.enum(['auto', 'local', 'deny']).default('local')
    })
    .default({ enabled: false, approval: 'local' })
});
export type MonadSystemConfig = z.infer<typeof monadSystemConfigSchema>;

export const monadConfigSchema = monadSystemConfigSchema
  .extend(monadAgentsConfigSchema.omit({ version: true }).shape)
  .extend(monadMeshConfigSchema.omit({ version: true }).shape);
export type MonadConfig = z.infer<typeof monadConfigSchema>;

export const CONFIG_SCHEMA_CONTENT = toMonadJsonSchema(monadSystemConfigSchema);
export function createDefaultConfig(displayName: string): MonadConfig {
  return {
    version: CURRENT_CONFIG_VERSION,
    user: { displayName, avatarDataUrl: null },
    appearance: { avatarStyle: DEFAULT_AVATAR_STYLE, composer: DEFAULT_COMPOSER_SETTINGS },
    model: {
      default: '',
      providers: [
        {
          id: DEFAULT_SAMPLE_PROVIDER_ID,
          label: 'Sample OpenAI-Compatible Provider',
          type: ModelProviderType.OpenAICompatible,
          baseUrl: 'https://api.example.com/v1'
        }
      ],
      profiles: [
        {
          alias: DEFAULT_SAMPLE_PROFILE_ALIAS,
          routes: { chat: { provider: DEFAULT_SAMPLE_PROVIDER_ID, modelId: 'example-model' } },
          params: { temperature: 0.7 },
          fallbacks: []
        }
      ],
      roles: {},
      tierOverrides: {},
      kinds: {}
    },
    agent: {
      agents: [],
      globalSandbox: { enabled: false, mode: 'workspace' },
      tools: { codeExecBackend: 'follow-system', webSearch: { provider: 'auto' }, email: { backend: 'auto' } },
      approvals: { deny: [], ask: [], allow: [] }
    },
    sandbox: {
      mode: 'workspace',
      confine: true,
      net: 'unrestricted',
      allowedDomains: [],
      deniedDomains: [],
      tlsTerminate: { enabled: false },
      credentials: [],
      hostExec: 'ask',
      env: {},
      allowUnconfinedExec: false,
      backend: 'auto',
      activeBackend: { source: 'builtin', kind: 'auto' },
      backendSettings: {}
    },
    skills: { autoload: true, disabled: [], autoloadDisabled: [], installReview: false },
    network: {
      port: 52749,
      host: '127.0.0.1',
      transport: DEFAULT_TRANSPORT,
      https: { enabled: false },
      remoteAccess: { enabled: false, token: null },
      localHttpFallback: { enabled: false, port: DEFAULT_LOCAL_HTTP_FALLBACK_PORT }
    },
    mcpServers: [],
    acpAgents: [],
    meshAgents: [],
    peers: [],
    browser: { enabled: false, vision: false, headless: true },
    computer: { enabled: false, command: 'uvx', args: ['computer-control-mcp@latest'] },
    mo: { enabled: true },
    obscura: { enabled: false, stealth: false },
    monadix: { enabled: false },
    channels: [],
    locale: 'en',
    atomPins: {},
    developerMode: defaultDeveloperMode(),
    observability: { endpoint: '' },
    openaiCompat: { enabled: false, approval: 'local' },
    memory: { backend: 'builtin', level: 1, mem0: {} },
    context: {
      eviction: { enabled: true, atFraction: 0.5, keepRecentRounds: 3, clearAtLeast: 2000, minResultTokens: 200 },
      summarize: { softFraction: 0.6, hardFraction: 0.9, background: true },
      toolOutput: { maxChars: 24_000, persistRaw: true, rawCapBytes: 2_000_000 },
      recitation: { enabled: false },
      memoryPromotion: { mode: 'off' },
      handoffNudge: { enabled: false, atFraction: 0.7 },
      retrieval: { enabled: false, minScore: 0.7, maxResults: 3 }
    }
  };
}
