import { chmod, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  agentAtomsSchema,
  agentVisibilitySchema,
  channelAllowlistSchema,
  channelGroupPolicySchema,
  channelTypeSchema,
  fallbackTargetViewSchema,
  hookMatcherSettingSchema,
  httpUrlSchema,
  ModelProviderType,
  modelKindSchema,
  modelProfileRoutesSchema,
  modelRolesSchema,
  nativeCliAgentViewSchema,
  KNOWN_PROVIDER_TYPES as PROTOCOL_KNOWN_PROVIDER_TYPES,
  sandboxModeSchema
} from '@monad/protocol';

// GenerationParams / FallbackTarget are owned by @monad/protocol (single source). home keeps its
// own stricter parse schema for GenerationParams (disk-boundary bounds) but derives the type.
export type { FallbackTargetView as FallbackTarget, GenerationParams, SandboxMode } from '@monad/protocol';

// sandboxModeSchema is owned by @monad/protocol (single source of truth); re-export so existing
// `@monad/home` importers (apps/monad, sdk-atom) keep their import path.
export { sandboxModeSchema } from '@monad/protocol';

import { toJSONSchema, z } from 'zod';

export type { ModelProviderType } from '@monad/protocol';

export { PROTOCOL_KNOWN_PROVIDER_TYPES as KNOWN_PROVIDER_TYPES };

import { friendlySchemaError } from './config-errors.ts';
import { runMigrations } from './migrate.ts';
import { matchEnvRef } from './secret-ref.ts';

const CONFIG_MIGRATIONS_DIR = join(import.meta.dir, 'migrations', 'config');
const PROFILE_MIGRATIONS_DIR = join(import.meta.dir, 'migrations', 'profile');
const AUTH_MIGRATIONS_DIR = join(import.meta.dir, 'migrations', 'auth');

// Pre-release: the full schema is a single v1 entry — edit it freely instead of writing
// incremental migrations. When the schema changes post-release: bump the constant, update the
// schema below, drop a new vN.ts in the matching migrations/ subdirectory, and add a test fixture.
export const CURRENT_CONFIG_VERSION = 1;
export const CURRENT_PROFILE_VERSION = 1;
export const CURRENT_AUTH_VERSION = 1;

// config.schema.json / profile.schema.json are dev-only generated artifacts (gitignored): the
// editor `$schema` points at them during dev. The schema CONTENT shipped in the binary (written
// to runtime/ by initMonadHome) is derived from the zod schema at load time via the same transform
// the gen-*-schema.ts scripts apply — so a clean checkout (CI/release) needs no file on disk.
// SCHEMA_CONTENT / PROFILE_SCHEMA_CONTENT are defined below, once their schemas exist.
function toMonadJsonSchema(schema: z.ZodType): string {
  const json = toJSONSchema(schema, { target: 'draft-07' }) as {
    $schema?: string;
    properties?: Record<string, unknown>;
  };
  json.$schema = 'http://json-schema.org/draft-07/schema#';
  // $schema itself must be allowed so editors don't flag their own annotation.
  if (json.properties) json.properties.$schema = { type: 'string' };
  return JSON.stringify(json, null, 2);
}

// In development, point directly at the source file so edits are live.
// In production, initMonadHome writes the schema to runtime/ and calls
// setSchemaRuntimeDir to flip this to the local file:// path.
let _schemaUrl =
  Bun.env.NODE_ENV === 'development' ? pathToFileURL(join(import.meta.dir, '..', 'config.schema.json')).href : '';
let _profileSchemaUrl =
  Bun.env.NODE_ENV === 'development' ? pathToFileURL(join(import.meta.dir, '..', 'profile.schema.json')).href : '';

export function setSchemaRuntimeDir(runtimeDir: string): void {
  if (Bun.env.NODE_ENV !== 'development') {
    _schemaUrl = pathToFileURL(join(runtimeDir, 'config.schema.json')).href;
    _profileSchemaUrl = pathToFileURL(join(runtimeDir, 'profile.schema.json')).href;
  }
}

const credentialSchema = z.object({
  id: z.string(),
  label: z.string(),
  authType: z.enum(['api_key', 'oauth', 'admin_api_key']),
  priority: z.number(),
  source: z.string(),
  accessToken: z.string(),
  baseUrl: z.string().optional(),
  lastStatus: z.enum(['ok', 'error', 'unknown']),
  lastStatusAt: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  lastErrorReason: z.string().nullable(),
  lastErrorMessage: z.string().nullable(),
  lastErrorResetAt: z.string().nullable(),
  requestCount: z.number()
});

// Channel bot credentials, keyed by channel instance id (chn_…). Secrets live in
// auth.json, never config.json (config stores only a `${secret:channel/<id>/token}` ref).
const channelCredentialSchema = z.object({
  token: z.string(),
  extra: z.record(z.string(), z.string()).optional()
});
export type ChannelCredential = z.infer<typeof channelCredentialSchema>;

// Peer daemon credentials, keyed by peer id (peer_…). The token is the remote daemon's
// OpenAI-compat bearer; it lives in auth.json, never config.json (config stores only a
// `${secret:peer/<id>/token}` ref).
const peerCredentialSchema = z.object({
  token: z.string()
});
export type PeerCredential = z.infer<typeof peerCredentialSchema>;

// OAuth tokens for http MCP servers, keyed by server config name. Secrets live in auth.json, never config.json.
const mcpOAuthTokenSchema = z.object({
  clientId: z.string().optional(), // from DCR or preconfigured
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.number().optional(), // epoch ms
  tokenEndpoint: z.string(),
  resource: z.string() // RFC 8707 canonical URI the token is bound to
});
export type McpOAuthToken = z.infer<typeof mcpOAuthTokenSchema>;

// Credentials for installing atoms from private sources. Secrets in auth.json, never config.json.
const atomRegistriesSchema = z.object({
  github: z.object({ token: z.string() }).optional(),
  npm: z.object({ token: z.string(), registry: z.string().optional() }).optional()
});
export type AtomRegistries = z.infer<typeof atomRegistriesSchema>;

const monadAuthSchema = z.object({
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

/** A fresh empty auth record — the fallback when auth.json is absent. One source so a new required
 *  MonadAuth field can't be silently missed by an ad-hoc literal. */
export function emptyAuth(): MonadAuth {
  return {
    version: CURRENT_AUTH_VERSION,
    activeProvider: null,
    updatedAt: new Date().toISOString(),
    credentialPool: {}
  };
}

// monad's model layer is a "gateway of gateways": every `provider` is one place a
// request can be sent — a direct provider (anthropic/openai/openai-compatible) or
// another gateway (vercel/openrouter/cloudflare). A `profile` is a named, user-facing
// model config (alias → provider + modelId + params + fallbacks + role overrides). The
// fixed "default" profile is used when a request doesn't specify one. Secrets never live here —
// credentials are stored per-provider in auth.json's credentialPool.

const providerTypeSchema = z.enum(PROTOCOL_KNOWN_PROVIDER_TYPES);

export const DEFAULT_SAMPLE_PROVIDER_ID = 'sample-openai-compatible';
export const DEFAULT_SAMPLE_PROFILE_ALIAS = 'sample-compatible';

const providerSchema = z.object({
  id: z.string(), // also the credentialPool bucket key in auth.json
  label: z.string(),
  type: providerTypeSchema,
  baseUrl: httpUrlSchema.optional(), // required for openai-compatible & cloudflare-gateway; optional override elsewhere
  extra: z.record(z.string(), z.string()).optional() // free-form provider knobs (e.g. cloudflare account id / gateway slug)
});

export type Provider = z.infer<typeof providerSchema>;

const generationParamsSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
    topP: z.number().min(0).max(1).optional(),
    reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).optional()
  })
  .strict();

const profileSchema = z.object({
  alias: z.string(),
  routes: modelProfileRoutesSchema,
  params: generationParamsSchema.default({}),
  fallbacks: z.array(fallbackTargetViewSchema).default([])
});

export type ModelProfile = z.infer<typeof profileSchema>;

/**
 * Default client transport for this host, chosen at init and overridable later via
 * `network.transport` in config.json:
 *   - Linux        → "uds"  (HTTP-over-Unix-socket: idiomatic, no listening TCP port
 *                            needed for local RPC, and where UDS pays off most)
 *   - macOS/Windows → "tcp" (plain HTTP over 127.0.0.1 loopback; on macOS UDS shows
 *                            no latency win, and Bun's Windows UDS support is incomplete)
 *
 * This selects only the LOCAL client's REST/SSE transport. The daemon always serves
 * both, and WS push is always TCP (Bun's WebSocket client has no unix-socket option).
 */
export function defaultTransport(): 'tcp' | 'uds' {
  return process.platform === 'linux' ? 'uds' : 'tcp';
}

const agentConfigSchema = z.object({
  id: z.string().regex(/^agt_/, 'agent id must start with agt_'),
  name: z.string().min(1).max(100),
  /** Model profile alias this agent uses by default. Falls back to the fixed "default" profile if unset. */
  modelAlias: z.string().optional(),
  /** Per-agent model-role overrides. Any unset role inherits the selected profile's role assignment
   *  (resolveAgentModelRole). E.g. an agent can use a cheaper memory model. */
  roles: modelRolesSchema.optional(),
  framework: z.enum(['openclaw', 'hermes', 'manus', 'monad', 'custom']).optional(),
  capabilities: z.array(z.string()).default([]),
  declaredScopes: z
    .array(z.object({ resource: z.string(), constraints: z.record(z.string(), z.unknown()).optional() }))
    .default([]),
  /** Per-agent skill auto-load override: `autoload` overrides the global master for this agent;
   *  `disabled` stores skill instance ids whose descriptions don't auto-load for it. */
  skills: z
    .object({
      autoload: z.boolean().optional(),
      disabled: z.array(z.string()).default([])
    })
    .optional(),
  /** Slug dir under <paths.agents> holding this agent's AGENT.md (frontmatter + system-prompt body)
   *  and per-agent workspace. Absent on legacy rows → name slug. Traversal-safe. */
  dir: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
  /** One-line description (Claude-subagent frontmatter `description`) — drives delegation routing. */
  description: z.string().max(1024).optional(),
  /** Profile alias | 'inherit'. Falls back to the fixed "default" profile when unset. */
  model: z.string().optional(),
  /** Per-agent tool/atom exposure filter. Empty/inherit → daemon-enabled atoms. */
  atoms: agentAtomsSchema.default({ mode: 'inherit', allow: [], deny: [] }),
  /** Per-agent sandbox override. Absent → inherit cfg.agent.sandbox; globalSandbox still ceilings it. */
  sandbox: z.object({ mode: sandboxModeSchema }).optional(),
  maxTurns: z.number().int().positive().optional(),
  maxThinkingTokens: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  visibility: agentVisibilitySchema.default({ subagentCallable: false, public: false }),
  /** P3 — populated when published to Monadix; absent until then. */
  published: z
    .object({
      providerId: z.string(),
      publishedAt: z.string(),
      lastConversationId: z.string().optional()
    })
    .optional()
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

// External MCP servers the daemon connects to at startup. Transport: `stdio` (subprocess,
// implemented) or `http` (streamable HTTP, schema-ready for a later phase).
// Secrets: string values in `env`/`token`/`headers` may use `${env:NAME}` — resolved
// from the daemon's environment at connect time (see resolveSecretRef). This keeps tokens
// out of config.json. `${secret:name}` is reserved for a later phase.

// autoApproveTools lists fully-qualified tool names (`<server>.<tool>`) exempt from the
// per-call approval gate; pinnedToolHash locks the advertised tool set so a server can't
// silently swap tool behaviour (rug-pull) after the operator vetted it.
// hostEscape marks a server whose NON-auto-approved tools drive the user's real machine
// (computer-use): those tools are gated as host-escape — approvable for a session but never as a
// permanent global/agent "always allow" (see the approval engine's host-control class).
export const mcpTrustSchema = z
  .object({
    autoApproveTools: z.array(z.string()).default([]),
    pinnedToolHash: z.string().optional(),
    hostEscape: z.boolean().default(false)
  })
  .default({ autoApproveTools: [], hostEscape: false });

// Operator-set static approval policy. Each entry is a tool name or `tool:key` (the Tool.gateKey
// form, e.g. 'code_execute:target:host', 'shell_exec:git'). `deny` hard-refuses (deny wins over any
// runtime allow); `allow` auto-approves; `ask` is the default and listed only for documentation.
// These are immutable (source:'operator') — the engine never persists over them.
export const agentApprovalsSchema = z
  .object({
    deny: z.array(z.string()).default([]),
    ask: z.array(z.string()).default([]),
    allow: z.array(z.string()).default([])
  })
  .default({ deny: [], ask: [], allow: [] });

const mcpStdioServerSchema = z.object({
  name: z.string().min(1),
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
  trust: mcpTrustSchema
});

const mcpHttpAuthSchema = z
  .discriminatedUnion('mode', [
    z.object({ mode: z.literal('none') }),
    z.object({ mode: z.literal('bearer'), token: z.string() }),
    z.object({ mode: z.literal('headers'), headers: z.record(z.string(), z.string()) }),
    z.object({
      mode: z.literal('oauth'),
      clientId: z.string().optional(),
      scopes: z.array(z.string()).default([]),
      // 'loopback' = browser + localhost redirect (default); 'device' = RFC 8628 device
      // code, for headless/remote daemons where a loopback redirect is unreachable.
      flow: z.enum(['loopback', 'device']).default('loopback')
    })
  ])
  .default({ mode: 'none' });

const mcpHttpServerSchema = z.object({
  name: z.string().min(1),
  transport: z.literal('http'),
  url: z.string().url(),
  auth: mcpHttpAuthSchema,
  headers: z.record(z.string(), z.string()).optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
  trust: mcpTrustSchema
});

export const mcpServerSchema = z.discriminatedUnion('transport', [mcpStdioServerSchema, mcpHttpServerSchema]);
export type McpServerConfig = z.infer<typeof mcpServerSchema>;

// External ACP agents monad can DELEGATE subtasks to (monad drives them as an ACP client via the
// `agent_acp_delegate` tool). The model picks a registered NAME — arbitrary commands are never
// allowed (that would be RCE); only operator-vetted entries here can be spawned. `env` values may
// use `${env:NAME}` secret refs (resolved at spawn time), keeping tokens out of config.json.
export const acpAgentSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  enabled: z.boolean().default(true),
  // Opt-in OS-level double-sandbox: when true, the adapter PROCESS is also wrapped by monad's
  // sandbox launcher (writes jailed to the session roots) on top of ACP's capability-level
  // interception. Named `osSandbox` to disambiguate from the daemon-wide `agent.sandbox.confine`
  // (which ARMS the launcher). Default OFF because the launcher redirects HOME, which breaks adapters
  // that read the user's real login state (~/.codex, ~/.claude). Operators enable it per agent once
  // they've supplied auth via env (e.g. ANTHROPIC_API_KEY / CODEX_HOME) so it survives the redirect.
  osSandbox: z.boolean().default(false),
  // Opt-in: forward monad's configured MCP servers (with resolved secrets) to THIS agent's delegated
  // session so it shares monad's external tools. Default OFF — forwarding hands resolved credentials
  // to third-party adapter code and spawns a second copy of each stdio MCP server, so it's a per-agent
  // choice (like `osSandbox`), not blanket behavior.
  forwardMcp: z.boolean().default(false)
});
export type AcpAgentConfig = z.infer<typeof acpAgentSchema>;

export const nativeCliAgentSchema = nativeCliAgentViewSchema;
export type NativeCliAgentConfig = z.infer<typeof nativeCliAgentSchema>;

// Browser automation preset. When enabled, the daemon auto-connects the official
// Playwright MCP server named "browser" — no manual mcpServers entry needed.
// A user-defined mcpServers entry named "browser" takes precedence and this preset
// steps aside (see main.ts), letting operators bring a remote/cloud browser via config only.
export const browserConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    vision: z.boolean().default(false),
    headless: z.boolean().default(true),
    /** Override the launch command to point at a non-Playwright browser MCP server (e.g.
     *  chrome-devtools-mcp, Stagehand). When set, `args` is used verbatim and the Playwright-specific
     *  flags + read-only auto-approve below are skipped (those tool names are Playwright's). Leave
     *  unset for the default `npx @playwright/mcp`. */
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    /** Browser engine/channel: chrome | firefox | webkit | msedge. */
    engine: z.enum(['chrome', 'firefox', 'webkit', 'msedge']).optional(),
    /** Device to emulate, e.g. "iPhone 15". */
    device: z.string().optional(),
    /** Navigation allow/block lists (RFC origins) — constrain where the agent may browse. */
    allowedOrigins: z.array(z.string()).optional(),
    blockedOrigins: z.array(z.string()).optional(),
    /** Persistent profile dir (keeps logins across runs). Mutually exclusive with isolated. */
    userDataDir: z.string().optional(),
    /** Load cookies/localStorage from a Playwright storageState file into an isolated context. */
    storageState: z.string().optional(),
    /** Keep the profile in memory only (no disk persistence). */
    isolated: z.boolean().optional(),
    /** Auto-approve the read-only browser tools (snapshot/screenshot/reads) so the agent
     *  isn't gated on every page read; mutating tools (navigate/click/type/evaluate) still
     *  route through the approval gate. Default-on; set false to gate everything. */
    autoApproveReadOnly: z.boolean().optional()
  })
  .default({ enabled: false, vision: false, headless: true });
export type BrowserConfig = z.infer<typeof browserConfigSchema>;

// Computer-use preset. When enabled, the daemon auto-connects an off-the-shelf desktop-control
// MCP server (screenshot + mouse/keyboard) as a synthesized "computer" stdio server — unless the
// operator already defined one named "computer". Unlike the browser preset there is no single
// canonical server, so command/args are overridable; the default targets the cross-platform
// AB498/computer-control-mcp (run via uvx). Point it at any other (trycua, MCPControl, a sandbox
// VM's server…) by setting command/args.
// SECURITY: this drives the REAL desktop and can click/type anywhere. It is OFF by default; every
// mutating action still routes through the per-call approval gate (only read-only tools below are
// auto-approved). Prefer a sandboxed/VM server over host control for untrusted tasks.
export const computerConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Launch command for the computer-use MCP server. */
    command: z.string().default('uvx'),
    /** Args for the launch command. */
    args: z.array(z.string()).default(['computer-control-mcp@latest']),
    /** Extra env for the server process (values may use ${env:NAME}). */
    env: z.record(z.string(), z.string()).optional(),
    /** Auto-approve read-only tools (screenshot/screen-size/cursor/window-list); mutating tools
     *  (click/type/drag/key/scroll) always route through the approval gate. Default-on. */
    autoApproveReadOnly: z.boolean().optional()
  })
  .default({ enabled: false, command: 'uvx', args: ['computer-control-mcp@latest'] });
export type ComputerConfig = z.infer<typeof computerConfigSchema>;

export const obscuraConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    stealth: z.boolean().default(false),
    requestTimeoutMs: z.number().int().positive().optional()
  })
  .default({ enabled: false, stealth: false });
export type ObscuraConfig = z.infer<typeof obscuraConfigSchema>;

export const moConfigSchema = z
  .object({
    // Whether the daemon launches the Mo desktop sprite on startup. Defaults on (Mo is enabled out of
    // the box); the web/cli start-stop toggle persists this so the choice survives a daemon restart.
    enabled: z.boolean().default(true),
    // Absolute path to the Mo desktop-sprite binary. Absent/empty → the daemon auto-locates the
    // bundled Mo next to bin/monad (and the repo build in dev); set this only to point at a custom
    // build. A config key rather than an env var so the override is observable in config.json.
    binaryPath: z.string().optional()
  })
  .default({ enabled: true });
export type MoConfig = z.infer<typeof moConfigSchema>;

/**
 * Resolve a peer token reference. Mirrors resolveChannelSecretRef for the
 * `${secret:peer/<id>/token}` scheme (reads auth.json's peerCredentials), so the remote
 * daemon's bearer never lives in config.json. `${env:NAME}` and plain values still pass.
 */
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

// A peer is another monad daemon this one can delegate tasks to over its OpenAI-compat API.
// The model never sees the url/token — it names a peer; the tool resolves it here. Infra/security
// concern (a delegation target + its credential), so it lives in system config like acpAgents.
const peerSchema = z.object({
  id: z.string().regex(/^peer_/, 'peer id must start with peer_'),
  label: z.string().min(1),
  /** Remote daemon's OpenAI-compat base, e.g. https://host:port/openai (no trailing /v1). */
  baseUrl: z.string().url(),
  /** Default target agent on the peer (name or agt_ id) when the model omits one. */
  defaultAgent: z.string().default('default'),
  /** Token reference: `${secret:peer/<id>/token}` (auth.json) or `${env:NAME}`. */
  tokenRef: z.string(),
  /** Created disabled; enabled once a token is set so the tool only offers usable peers. */
  enabled: z.boolean().default(false)
});
export type PeerConfig = z.infer<typeof peerSchema>;

const channelInstanceSchema = z.object({
  id: z.string().regex(/^chn_/, 'channel id must start with chn_'),
  type: channelTypeSchema,
  label: z.string().min(1),
  enabled: z.boolean().default(true),
  /** Agent this channel's sessions use; falls back to agent.defaultAgentId. */
  agentId: z.string().optional(),
  /** Non-secret adapter options (e.g. telegram poll timeout). */
  options: z.record(z.string(), z.unknown()).default({}),
  // Default-DENY: a new channel rejects everyone until the operator allowlists native user ids (or
  // approves them via the pairing flow). The access policy + allowlist schema is shared with the
  // wire DTO in @monad/protocol so config and HTTP view stay in lockstep.
  allowlist: channelAllowlistSchema.default({ allowAllUsers: false, allowedUsers: [] }),
  // Native user ids trusted to run owner-only commands (e.g. /workdir) over this channel. A channel
  // guest is never the daemon owner; this is the explicit, per-channel opt-in for an IM operator.
  ownerUsers: z.array(z.string()).default([]),
  // Group behaviour: by default the bot only answers in a group when addressed (mention/reply).
  // Optional for back-compat — the core resolves an absent policy to requireMention=true.
  groupPolicy: channelGroupPolicySchema.optional(),
  /** Per-channel system-prompt hint injected into this channel's sessions (Hermes platform_hint). */
  agentHint: z.string().max(2000).optional(),
  // Conversation→session granularity is a CORE policy; the atom pack never sees it.
  mapping: z
    .object({
      granularity: z.enum(['per-conversation', 'per-thread', 'per-user']).default('per-conversation'),
      reset: z.object({ idleMinutes: z.number().int().positive().optional(), daily: z.boolean().optional() }).optional()
    })
    .default({ granularity: 'per-conversation' }),
  /** Token reference: `${env:TELEGRAM_BOT_TOKEN}` or `${secret:channel/<id>/token}` (auth.json). */
  tokenRef: z.string(),
  /** Per-(channel,user) rate limit (messages/min). */
  rateLimitPerMin: z.number().int().positive().default(20)
});
export type ChannelInstanceConfig = z.infer<typeof channelInstanceSchema>;

// Lifecycle command hooks (shell), in an `event → matcher[] → hooks[]` shape. The matcher (a regex)
// filters BeforeTool/AfterTool by tool name. In-process atom-pack hooks register separately via the
// SDK. Secrets never belong here.
// The command-hook + matcher leaf shape is owned by @monad/protocol (hookMatcherSettingSchema);
// home derives the per-event config from it rather than re-declaring the fields.
const hookEventArraySchema = z.array(hookMatcherSettingSchema);
const hooksConfigSchema = z.object({
  SessionStart: hookEventArraySchema.optional(),
  BeforeTurn: hookEventArraySchema.optional(),
  BeforeModel: hookEventArraySchema.optional(),
  BeforeTool: hookEventArraySchema.optional(),
  ApprovalRequest: hookEventArraySchema.optional(),
  AfterTool: hookEventArraySchema.optional(),
  AfterModel: hookEventArraySchema.optional(),
  BeforeCompact: hookEventArraySchema.optional(),
  AfterCompact: hookEventArraySchema.optional(),
  BeforeSubagent: hookEventArraySchema.optional(),
  AfterSubagent: hookEventArraySchema.optional(),
  AfterTurn: hookEventArraySchema.optional(),
  SessionEnd: hookEventArraySchema.optional()
});
export type HooksConfig = z.infer<typeof hooksConfigSchema>;

// Active L1 memory backend (single, mutually-exclusive). 'builtin' = local Markdown store;
// 'mem0' = mem0 OSS (local storage, cloud extraction — data leaves the machine, so OTR is
// disabled while it's active). Hot-reloadable user preference (lives in profile.json).
export const memorySettingsSchema = z
  .object({
    backend: z.enum(['builtin', 'mem0']).default('builtin'),
    // mem0 selects its LLM + embedder FROM Monad's model registry — `llm`/`embedder` are profile
    // aliases (or `providerId:modelId`). Unset ⇒ LLM falls back to the fixed "default" profile,
    // embedder to the default profile's embedding role. `embedDim` overrides the auto-detected
    // embedding dimension.
    mem0: z
      .object({
        llm: z.string().optional(),
        embedder: z.string().optional(),
        embedDim: z.number().int().positive().optional(),
        // By DEFAULT (vectorStore unset) mem0 persists to a daemon-managed local qdrant, downloaded on
        // first use (see `qdrant` below). Set `vectorStore` to override with your own store, e.g.
        // { provider: 'pgvector', config: { … } }, or { provider: 'memory' } to opt out (in-RAM, resets
        // on restart). collectionName + dimension are filled in automatically.
        vectorStore: z
          .object({ provider: z.string().min(1), config: z.record(z.string(), z.unknown()).optional() })
          .optional(),
        // Settings for the default managed local qdrant (used when vectorStore is unset). `port` is its
        // loopback REST port (gRPC binds port+1); set per worktree to avoid collisions.
        qdrant: z.object({ version: z.string().optional(), port: z.number().int().positive().optional() }).optional()
      })
      .default({}),
    // L2 knowledge graph. Off by default — when on, the daemon runs /consolidate-graph in the
    // background every `intervalMinutes` so the graph stays fresh (costs an extraction LLM call per
    // session with new prose). Manual /consolidate-graph works regardless.
    graph: z
      .object({
        autoConsolidate: z.boolean().optional(),
        intervalMinutes: z.number().int().positive().optional()
      })
      .optional()
  })
  .default({ backend: 'builtin', mem0: {} });
export type MemorySettings = z.infer<typeof memorySettingsSchema>;

const monadConfigSchema = z.object({
  version: z.literal(CURRENT_CONFIG_VERSION),
  principal: z.object({
    id: z.string().regex(/^prn_/, 'principal id must start with prn_'),
    displayName: z.string(),
    verification: z.enum(['unverified', 'email', 'domain', 'attested'])
  }),
  model: z.object({
    default: z.string(), // legacy; runtime defaults to the fixed "default" profile
    providers: z.array(providerSchema).default([]),
    profiles: z.array(profileSchema).default([]),
    // Legacy global model-role assignments. Runtime role routing is stored on profiles.
    roles: modelRolesSchema.default({}),
    // Operator pins for capability-tier routing: profile alias → tier. Overrides the catalog's
    // automatic cost-ranking when resolving a `context: fork` skill's declared tier. Additive.
    tierOverrides: z.record(z.string(), z.enum(['fast'])).default({}),
    // Manual model-kind overrides ("providerId:modelId" → kind), the final authority over the
    // layered inference (provider self-report → models.dev catalog → id heuristic). Lets an
    // embedding model whose id doesn't match the heuristic still surface as a candidate. Additive.
    kinds: z.record(z.string(), modelKindSchema).default({})
  }),
  agent: z.object({
    /** Registered agents. Persisted here alongside providers/profiles. */
    agents: z.array(agentConfigSchema).default([]),
    /** ID of the agent used when sessions.create omits agentId. */
    defaultAgentId: z.string().optional(),
    sandbox: z.object({
      mode: sandboxModeSchema,
      // OS-level confinement (Seatbelt/Landlock/AppContainer) for the children spawned by
      // code_execute / shell_exec / process_start. Writes are confined to the session's sandbox
      // roots; reads are not. Off → today's bare host child (no kernel fence). Additive default so
      // existing configs parse. Unsupported platforms (no native launcher yet) degrade to no-op.
      confine: z.boolean().default(true),
      // Network for confined children:
      //   'none'         → no egress
      //   'unrestricted' → open (default — keeps npm/pip/curl working out of the box)
      //   'filtered'     → only a local proxy is reachable; the child's curl/pip/npm/git egress is
      //                    allowed only to `allowedDomains` (subdomains included)
      net: z.enum(['none', 'unrestricted', 'filtered']).default('unrestricted'),
      // Egress allowlist for net:'filtered' (domains; subdomains match). Empty → deny all egress.
      allowedDomains: z.array(z.string()).default([]),
      // code_execute target:'host' (run unconfined on the real machine): 'deny' refuses it, 'ask'
      // allows it with human approval (default), 'allow' permits it (still approved — host runs are
      // always gated). Sandbox-target runs are unaffected.
      hostExec: z.enum(['deny', 'ask', 'allow']).default('ask'),
      // Static env vars injected into every confined child (API base URLs, locale overrides, etc.).
      // Applied before proxy env so HTTP(S)_PROXY can always override. Additive; empty = none.
      env: z.record(z.string(), z.string()).default({}),
      // Ephemeral-mode only: a local directory whose contents are copied into every fresh session
      // root on creation — pre-seeded scaffold, requirements.txt, data files, etc.
      seedTemplate: z.string().optional(),
      // Ephemeral-mode only: a shell command run inside the session root after seeding completes
      // (e.g. 'python -m venv .venv && pip install -r requirements.txt'). Runs confined.
      initScript: z.string().optional(),
      // Override path to the monad-sandbox-launcher native binary. Absent → binary next to the
      // monad executable (standard install). Useful when testing a custom build or running in an
      // environment where the binary is installed to a non-standard location.
      launcherPath: z.string().optional(),
      // Credential for a cloud sandbox launcher (e.g. an e2b API key), passed to the active
      // launcher's spawn()/isAvailable(). A `${secret:NAME}` / `${env:NAME}` ref (keeps the key out
      // of config.json) or a raw value. Only used when a remote (cloud) launcher is selected.
      credential: z.string().optional(),
      // Container image for the docker/podman launcher. Default: ubuntu:22.04.
      dockerImage: z.string().optional(),
      // DANGER: when confine=true but no launcher is available, allow children to run unconfined on
      // the host rather than refusing to start. Default is fail-closed. Set to true only when you
      // have intentionally deployed without a sandbox launcher and understand that agent-spawned
      // processes run with full host privileges.
      allowUnconfinedExec: z.boolean().default(false)
    }),
    // When enabled, EVERY agent is forced to `mode`; per-agent sandbox is ignored.
    globalSandbox: z
      .object({
        enabled: z.boolean(),
        mode: sandboxModeSchema
      })
      .default({ enabled: false, mode: 'workspace' }),
    tools: z
      .object({
        /** Override the shell binary (and implicitly its -c flag). POSIX and Windows. */
        shellPath: z.string().optional(),
        /** Windows-only: override the Git Bash binary path (skips install-location scan). */
        gitBashPath: z.string().optional(),
        /** Code-execute backend name. Only 'local' is built-in; plug in an external sandbox via MCP instead. */
        codeExecBackend: z.string().default('local'),
        /** Web search configuration. Secrets (apiKey) support ${env:NAME} refs. */
        webSearch: z
          .object({
            /** Search provider selection: 'native' prefers the model provider's built-in search when supported. */
            provider: z.enum(['auto', 'native', 'brave', 'ddgs']).default('auto'),
            brave: z
              .object({
                /** Brave Search API key. Supports ${env:NAME} secret refs. */
                apiKey: z.string()
              })
              .optional()
          })
          .default({ provider: 'auto' }),
        /** Outbound email configuration. Secrets (pass, apiKey) support ${env:NAME} refs. */
        email: z
          .object({
            /** Backend selection: 'auto' detects from present credentials, 'smtp'/'resend' forces one. */
            backend: z.enum(['auto', 'smtp', 'resend']).default('auto'),
            /** Default sender address (overridable per-message). */
            from: z.string().optional(),
            /** Resend HTTP backend. */
            resend: z
              .object({
                /** Resend API key. Supports ${env:NAME} secret refs. */
                apiKey: z.string()
              })
              .optional(),
            /** SMTP backend. */
            smtp: z
              .object({
                host: z.string(),
                port: z.number().int().positive().optional(),
                user: z.string().optional(),
                /** SMTP password. Supports ${env:NAME} secret refs. */
                pass: z.string().optional(),
                /** true = implicit TLS on 465; false = STARTTLS on 587. Default: auto from port. */
                secure: z.boolean().optional(),
                /** EHLO client name announced to the server. Default: 'monad'. */
                clientName: z.string().optional()
              })
              .optional()
          })
          .default({ backend: 'auto' })
      })
      .default({ codeExecBackend: 'local', webSearch: { provider: 'auto' }, email: { backend: 'auto' } }),
    // Operator-set static approval policy (deny/ask/allow tool lists). Participates in the approval
    // engine as immutable source:'operator' rules; deny always wins over runtime allows.
    approvals: agentApprovalsSchema
  }),
  // Skill switches keyed by skill instance id: `autoload` is the global master (off → no skill
  // descriptions auto-load anywhere). `disabled` fully disables a skill; `autoloadDisabled` keeps
  // it manually invocable only.
  skills: z
    .object({
      autoload: z.boolean().default(true),
      disabled: z.array(z.string()).default([]),
      autoloadDisabled: z.array(z.string()).default([]),
      installReview: z.boolean().default(false)
    })
    .default({ autoload: true, disabled: [], autoloadDisabled: [], installReview: false }),
  network: z
    .object({
      port: z.number().int().min(1).max(65535).default(52749),
      // Which socket the LOCAL client dials — daemon always serves both; WS push is always TCP.
      transport: z.enum(['tcp', 'uds']).default(defaultTransport),
      remoteAccess: z.object({
        // When true, daemon binds to 0.0.0.0 and requires a Bearer token for non-localhost requests.
        enabled: z.boolean(),
        token: z.string().nullable(),
        // DANGER: allow plain HTTP when TLS setup fails (openssl absent or cert error). Default is
        // fail-closed — the daemon refuses to start if remote access is enabled but TLS cannot be
        // provisioned. Set to true only if you're deploying behind a TLS-terminating proxy and
        // intentionally run the daemon-side transport unencrypted.
        allowInsecureHttp: z.boolean().default(false)
      })
    })
    .default(() => ({
      port: 52749,
      transport: defaultTransport(),
      remoteAccess: { enabled: false, token: null, allowInsecureHttp: false }
    })),
  mcpServers: z.array(mcpServerSchema).default([]),
  acpAgents: z.array(acpAgentSchema).default([]), // external ACP agents monad can delegate to
  nativeCliAgents: z.array(nativeCliAgentSchema).default([]),
  peers: z.array(peerSchema).default([]), // peer daemons this one can delegate tasks to
  browser: browserConfigSchema, // additive so older configs still parse
  computer: computerConfigSchema, // additive so older configs still parse
  mo: moConfigSchema, // additive so older configs still parse
  obscura: obscuraConfigSchema, // additive so older configs still parse
  channels: z.array(channelInstanceSchema).default([]), // additive so older configs still parse
  // Active UI/agent locale (BCP-47-ish tag, e.g. 'en', 'zh'). Resolved against the language packs
  // registered by `locale` atoms; an unknown tag falls back to English.
  locale: z.string().default('en'),
  // User pin overriding which atom pack wins a bare id when several packs register the same one
  // (tool/connector/channel/command/locale). Shape: { <kind>: { <bareId>: <packId> } }. Unset → the
  // default first-wins (sorted pack folder) applies. A pinned pack that is absent falls back to
  // first-wins. The fully-qualified `<packId>__<id>` form is always addressable regardless. Additive.
  atomPins: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  hooks: hooksConfigSchema.optional(),
  // Operator-managed policy hooks: same shape as `hooks`, but always run BEFORE user hooks and are
  // never written by the hooks settings API — a non-overridable layer for org-enforced PreToolUse
  // deny rules (SHELL command hooks only; atom-pack hooks are already operator-installed, not user
  // config). Pair with `onError: 'deny'` so a crashing guard fails closed. Edit config.json directly.
  policyHooks: hooksConfigSchema.optional(),
  observability: z
    .object({
      // OTLP HTTP endpoint for traces + metrics. Leave empty to disable.
      // Dev auto-starts Arize Phoenix on http://localhost:6006 (see scripts/setup-dev.ts) and
      // defaults the endpoint there; set this to "http://localhost:6006" to use it explicitly, or
      // point at any other OTLP/HTTP-protobuf collector.
      endpoint: z.string().default(''),
      developerMode: z.boolean().default(false)
    })
    .default({ endpoint: '', developerMode: false }),
  openaiCompat: z
    .object({
      enabled: z.boolean().default(false),
      // When set, all /openai/* requests must carry `Authorization: Bearer <token>`.
      token: z.string().optional(),
      // How high-risk tools in an inbound (peer-delegated) session are approved. The OpenAI-compat
      // stream has no interactive approval channel, so a delegated run can't forward to the caller:
      //   auto  → auto-approve (same-owner ONLY: anyone reaching this API can drive auto-approved
      //           high-risk tools, so opt in explicitly once the caller is authenticated as you)
      //   local → leave to this daemon's own clients to approve via the oversight gate (default)
      //   deny  → reject all high-risk tools (read-only delegation)
      approval: z.enum(['auto', 'local', 'deny']).default('local')
    })
    .default({ enabled: false, approval: 'local' }),
  memory: memorySettingsSchema
});

export { monadConfigSchema };
export type MonadConfig = z.infer<typeof monadConfigSchema>;

// Contains infrastructure and security settings that require a daemon restart.
export const monadSystemConfigSchema = z.object({
  version: z.literal(CURRENT_CONFIG_VERSION),
  principal: z.object({
    id: z.string().regex(/^prn_/, 'principal id must start with prn_'),
    displayName: z.string(),
    verification: z.enum(['unverified', 'email', 'domain', 'attested'])
  }),
  network: z
    .object({
      port: z.number().int().min(1).max(65535).default(52749),
      transport: z.enum(['tcp', 'uds']).default(defaultTransport),
      remoteAccess: z.object({
        enabled: z.boolean(),
        token: z.string().nullable(),
        allowInsecureHttp: z.boolean().default(false)
      })
    })
    .default(() => ({
      port: 52749,
      transport: defaultTransport(),
      remoteAccess: { enabled: false, token: null, allowInsecureHttp: false }
    })),
  agent: z.object({
    sandbox: z.object({
      mode: sandboxModeSchema,
      confine: z.boolean().default(true),
      net: z.enum(['none', 'unrestricted', 'filtered']).default('unrestricted'),
      allowedDomains: z.array(z.string()).default([]),
      hostExec: z.enum(['deny', 'ask', 'allow']).default('ask'),
      env: z.record(z.string(), z.string()).default({}),
      seedTemplate: z.string().optional(),
      initScript: z.string().optional(),
      allowUnconfinedExec: z.boolean().default(false)
    }),
    globalSandbox: z
      .object({ enabled: z.boolean(), mode: sandboxModeSchema })
      .default({ enabled: false, mode: 'workspace' }),
    tools: z
      .object({
        shellPath: z.string().optional(),
        gitBashPath: z.string().optional(),
        codeExecBackend: z.string().default('local')
      })
      .default({ codeExecBackend: 'local' }),
    // Operator static approval policy lives in system config (config.json), like mcpServers/acpAgents.
    approvals: agentApprovalsSchema
  }),
  mcpServers: z.array(mcpServerSchema).default([]),
  // External ACP agents are an operator/infra concern (spawn allowlist) → system config, like mcpServers.
  acpAgents: z.array(acpAgentSchema).default([]),
  nativeCliAgents: z.array(nativeCliAgentSchema).default([]),
  // Peer daemons (delegation targets + their credentials) → system config, like acpAgents.
  peers: z.array(peerSchema).default([]),
  observability: z.object({ endpoint: z.string().default(''), developerMode: z.boolean().default(false) }).default({
    endpoint: '',
    developerMode: false
  })
});
export type MonadSystemConfig = z.infer<typeof monadSystemConfigSchema>;

// Contains business and user-facing settings that hot-reload without restart.
export const monadProfileSchema = z.object({
  version: z.literal(CURRENT_PROFILE_VERSION),
  model: z.object({
    default: z.string(),
    providers: z.array(providerSchema).default([]),
    profiles: z.array(profileSchema).default([]),
    roles: modelRolesSchema.default({}),
    tierOverrides: z.record(z.string(), z.enum(['fast'])).default({}),
    kinds: z.record(z.string(), modelKindSchema).default({})
  }),
  agent: z
    .object({
      agents: z.array(agentConfigSchema).default([]),
      defaultAgentId: z.string().optional(),
      tools: z
        .object({
          webSearch: z
            .object({
              provider: z.enum(['auto', 'native', 'brave', 'ddgs']).default('auto'),
              brave: z.object({ apiKey: z.string() }).optional()
            })
            .default({ provider: 'auto' }),
          email: z
            .object({
              backend: z.enum(['auto', 'smtp', 'resend']).default('auto'),
              from: z.string().optional(),
              resend: z.object({ apiKey: z.string() }).optional(),
              smtp: z
                .object({
                  host: z.string(),
                  port: z.number().int().positive().optional(),
                  user: z.string().optional(),
                  pass: z.string().optional(),
                  secure: z.boolean().optional(),
                  clientName: z.string().optional()
                })
                .optional()
            })
            .default({ backend: 'auto' }),
          codeExecBackend: z.string().default('local')
        })
        .default({ webSearch: { provider: 'auto' }, email: { backend: 'auto' }, codeExecBackend: 'local' })
    })
    .default({
      agents: [],
      tools: { webSearch: { provider: 'auto' }, email: { backend: 'auto' }, codeExecBackend: 'local' }
    }),
  skills: z
    .object({
      autoload: z.boolean().default(true),
      disabled: z.array(z.string()).default([]),
      autoloadDisabled: z.array(z.string()).default([]),
      installReview: z.boolean().default(false)
    })
    .default({ autoload: true, disabled: [], autoloadDisabled: [], installReview: false }),
  browser: browserConfigSchema,
  computer: computerConfigSchema,
  mo: moConfigSchema,
  obscura: obscuraConfigSchema,
  channels: z.array(channelInstanceSchema).default([]),
  locale: z.string().default('en'),
  // User atom-pin overrides (hot-reloadable). { <kind>: { <bareId>: <packId> } }; unset → first-wins.
  atomPins: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  hooks: hooksConfigSchema.optional(),
  openaiCompat: z
    .object({
      enabled: z.boolean().default(false),
      token: z.string().optional(),
      approval: z.enum(['auto', 'local', 'deny']).default('local')
    })
    .default({ enabled: false, approval: 'local' }),
  memory: memorySettingsSchema
});
export type MonadProfile = z.infer<typeof monadProfileSchema>;

// Derived from the zod schemas above (not a file import) so a clean checkout needs no generated
// JSON on disk; initMonadHome writes these to runtime/ for editor `$schema` validation.
export const SCHEMA_CONTENT = toMonadJsonSchema(monadSystemConfigSchema);
export const PROFILE_SCHEMA_CONTENT = toMonadJsonSchema(monadProfileSchema);

export function createDefaultConfig(principalId: string, displayName: string): MonadConfig {
  return {
    version: CURRENT_CONFIG_VERSION,
    principal: { id: principalId, displayName, verification: 'unverified' },
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
      sandbox: {
        mode: 'workspace',
        confine: true,
        net: 'unrestricted',
        allowedDomains: [],
        hostExec: 'ask',
        env: {},
        allowUnconfinedExec: false
      },
      globalSandbox: { enabled: false, mode: 'workspace' },
      tools: { codeExecBackend: 'local', webSearch: { provider: 'auto' }, email: { backend: 'auto' } },
      approvals: { deny: [], ask: [], allow: [] }
    },
    skills: { autoload: true, disabled: [], autoloadDisabled: [], installReview: false },
    network: {
      port: 52749,
      transport: defaultTransport(),
      remoteAccess: { enabled: false, token: null, allowInsecureHttp: false }
    },
    mcpServers: [],
    acpAgents: [],
    nativeCliAgents: [],
    peers: [],
    browser: { enabled: false, vision: false, headless: true },
    computer: { enabled: false, command: 'uvx', args: ['computer-control-mcp@latest'] },
    mo: { enabled: true },
    obscura: { enabled: false, stealth: false },
    channels: [],
    locale: 'en',
    atomPins: {},
    observability: { endpoint: '', developerMode: false },
    openaiCompat: { enabled: false, approval: 'local' },
    memory: { backend: 'builtin', mem0: {} }
  };
}

export async function migrateConfig(raw: unknown): Promise<MonadConfig> {
  return runMigrations(raw, CURRENT_CONFIG_VERSION, CONFIG_MIGRATIONS_DIR, (data) => monadConfigSchema.parse(data));
}

export async function tryParseConfig(raw: unknown): Promise<MonadConfig | null> {
  try {
    return await migrateConfig(raw);
  } catch {
    return null;
  }
}

export async function tryParseProfile(profilePath: string): Promise<MonadProfile | null> {
  try {
    const raw = JSON.parse(await Bun.file(profilePath).text());
    return await migrateProfile(raw);
  } catch {
    return null;
  }
}

async function migrateSystemConfig(raw: unknown): Promise<MonadSystemConfig> {
  return runMigrations(raw, CURRENT_CONFIG_VERSION, CONFIG_MIGRATIONS_DIR, (data) =>
    monadSystemConfigSchema.parse(data)
  );
}

async function migrateProfile(raw: unknown): Promise<MonadProfile> {
  return runMigrations(raw, CURRENT_PROFILE_VERSION, PROFILE_MIGRATIONS_DIR, (data) => monadProfileSchema.parse(data));
}

function mergeConfigs(system: MonadSystemConfig, profile: MonadProfile): MonadConfig {
  return {
    version: system.version,
    principal: system.principal,
    network: system.network,
    agent: {
      ...system.agent,
      tools: { ...system.agent.tools, ...profile.agent.tools },
      agents: profile.agent.agents,
      defaultAgentId: profile.agent.defaultAgentId
    },
    mcpServers: system.mcpServers,
    acpAgents: system.acpAgents,
    nativeCliAgents: system.nativeCliAgents,
    peers: system.peers,
    model: profile.model,
    skills: profile.skills,
    browser: profile.browser,
    computer: profile.computer,
    mo: profile.mo,
    obscura: profile.obscura,
    channels: profile.channels,
    locale: profile.locale,
    atomPins: profile.atomPins,
    hooks: profile.hooks,
    observability: system.observability,
    openaiCompat: profile.openaiCompat,
    memory: profile.memory
  };
}

// Extract only the system fields from a full MonadConfig for writing to config.json.
function extractSystemConfig(cfg: MonadConfig): MonadSystemConfig {
  return monadSystemConfigSchema.parse({
    version: cfg.version,
    principal: cfg.principal,
    network: cfg.network,
    agent: {
      sandbox: cfg.agent.sandbox,
      globalSandbox: cfg.agent.globalSandbox,
      tools: cfg.agent.tools,
      // Round-trip the operator approval policy; omitting it lets the schema default ({}) silently
      // overwrite the on-disk allow/deny/ask rules on every system-config save.
      approvals: cfg.agent.approvals
    },
    mcpServers: cfg.mcpServers,
    acpAgents: cfg.acpAgents,
    nativeCliAgents: cfg.nativeCliAgents,
    peers: cfg.peers,
    observability: cfg.observability
  });
}

// Extract only the profile fields from a full MonadConfig for writing to profile.json.
function extractProfile(cfg: MonadConfig): MonadProfile {
  return monadProfileSchema.parse({
    version: CURRENT_PROFILE_VERSION,
    model: cfg.model,
    agent: {
      agents: cfg.agent.agents,
      defaultAgentId: cfg.agent.defaultAgentId,
      tools: {
        webSearch: cfg.agent.tools.webSearch,
        email: cfg.agent.tools.email,
        codeExecBackend: cfg.agent.tools.codeExecBackend
      }
    },
    skills: cfg.skills,
    browser: cfg.browser,
    computer: cfg.computer,
    mo: cfg.mo,
    obscura: cfg.obscura,
    channels: cfg.channels,
    locale: cfg.locale,
    atomPins: cfg.atomPins,
    hooks: cfg.hooks,
    openaiCompat: cfg.openaiCompat,
    memory: cfg.memory
  });
}

/**
 * Load both config.json (system) and profile.json (business settings) and merge
 * into a single MonadConfig. If profile.json is missing but config.json contains
 * profile fields (first boot after upgrade), profile.json is bootstrapped from it.
 */
export async function loadAll(configPath: string, profilePath: string): Promise<MonadConfig | null> {
  const [rawSystem, rawProfile] = await Promise.all([
    Bun.file(configPath)
      .text()
      .catch((err: unknown) => {
        if (isMissingFile(err)) return null;
        throw err;
      }),
    // initMonadHome always writes both files together; an absent profile.json falls back to defaults.
    Bun.file(profilePath)
      .text()
      .catch((err: unknown) => {
        if (isMissingFile(err)) return null;
        throw err;
      })
  ]);

  if (rawSystem === null) return null;

  let parsedSystem: unknown;
  try {
    parsedSystem = JSON.parse(rawSystem);
  } catch {
    throw new Error(`monad: config.json is not valid JSON at ${configPath}. Fix the file and retry.`);
  }
  let system: MonadSystemConfig;
  try {
    system = await migrateSystemConfig(parsedSystem);
  } catch (err) {
    throw friendlySchemaError('config.json', configPath, err);
  }

  let profile: MonadProfile;
  if (rawProfile !== null) {
    let parsedProfile: unknown;
    try {
      parsedProfile = JSON.parse(rawProfile);
    } catch {
      throw new Error(`monad: profile.json is not valid JSON at ${profilePath}. Fix the file and retry.`);
    }
    try {
      profile = await migrateProfile(parsedProfile);
    } catch (err) {
      throw friendlySchemaError('profile.json', profilePath, err);
    }
  } else {
    profile = monadProfileSchema.parse({ version: CURRENT_PROFILE_VERSION, model: { default: '' } });
  }

  return mergeConfigs(system, profile);
}

export async function saveSystemConfig(configPath: string, cfg: MonadConfig): Promise<void> {
  const system = extractSystemConfig(cfg);
  try {
    monadSystemConfigSchema.parse(system);
  } catch (err) {
    throw friendlySchemaError('config.json', configPath, err);
  }
  await atomicWrite(configPath, `${JSON.stringify({ $schema: _schemaUrl, ...system }, null, 2)}\n`);
  await setSecurePermissions(configPath); // holds network.remoteAccess.token — owner-only
}

export async function saveProfile(profilePath: string, cfg: MonadConfig): Promise<void> {
  const profile = extractProfile(cfg);
  try {
    monadProfileSchema.parse(profile);
  } catch (err) {
    throw friendlySchemaError('profile.json', profilePath, err);
  }
  await atomicWrite(profilePath, `${JSON.stringify({ $schema: _profileSchemaUrl, ...profile }, null, 2)}\n`);
  await setSecurePermissions(profilePath);
}

// Write config.json then profile.json in sequence so a file-watcher that fires
// between writes always reads a consistent state (system is stable before profile lands).
export async function saveAll(configPath: string, profilePath: string, cfg: MonadConfig): Promise<void> {
  await saveSystemConfig(configPath, cfg);
  await saveProfile(profilePath, cfg);
}

export async function tryParseAuth(raw: unknown): Promise<MonadAuth | null> {
  try {
    return await runMigrations(raw, CURRENT_AUTH_VERSION, AUTH_MIGRATIONS_DIR, (data) => monadAuthSchema.parse(data));
  } catch {
    return null;
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp`;
  await Bun.write(tmp, content);
  if (process.platform === 'win32') {
    try {
      await unlink(filePath);
    } catch {
      /* target may not exist yet */
    }
  }
  await rename(tmp, filePath);
}

async function setSecurePermissions(filePath: string): Promise<void> {
  if (process.platform !== 'win32') {
    await chmod(filePath, 0o600);
  }
}

// ENOTDIR can also mean "no file here" when a path component is a file, not a dir.
function isMissingFile(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export async function loadConfig(configPath: string): Promise<MonadConfig | null> {
  const siblingProfilePath = join(dirname(configPath), 'profile.json');
  return loadAll(configPath, siblingProfilePath);
}

export async function loadAuth(authPath: string): Promise<MonadAuth | null> {
  let raw: string;
  try {
    raw = await Bun.file(authPath).text();
  } catch (err) {
    if (isMissingFile(err)) return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return tryParseAuth(parsed);
}

export async function saveAuth(authPath: string, auth: MonadAuth): Promise<void> {
  try {
    monadAuthSchema.parse(auth);
  } catch (err) {
    throw friendlySchemaError('auth.json', authPath, err);
  }
  await atomicWrite(authPath, `${JSON.stringify(auth, null, 2)}\n`);
  await setSecurePermissions(authPath);
}
