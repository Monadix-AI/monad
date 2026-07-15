import {
  a2aAgentSettingsSchema,
  absoluteUriSchema,
  agentAtomsSchema,
  agentIdSchema,
  agentVisibilitySchema,
  channelAllowlistSchema,
  channelGroupPolicySchema,
  channelIdSchema,
  channelTypeSchema,
  externalAgentViewSchema,
  fallbackTargetViewSchema,
  hookMatcherSettingSchema,
  httpOriginSchema,
  httpUrlSchema,
  modelProfileRoutesSchema,
  modelRoleSchema,
  modelRolesSchema,
  monadixAgentSettingsSchema,
  KNOWN_PROVIDER_TYPES as PROTOCOL_KNOWN_PROVIDER_TYPES,
  peerIdSchema,
  sandboxModeSchema
} from '@monad/protocol';
import { z } from 'zod';

import { matchEnvRef } from '../secret-ref.ts';

// Pre-release: the full schema is a single v1 entry — edit it freely instead of writing
// incremental migrations. When the schema changes post-release: bump the constant, update the
// schema below, drop a new vN.ts in the matching migrations/ subdirectory, and add a test fixture.
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
  tokenEndpoint: httpUrlSchema,
  resource: absoluteUriSchema // RFC 8707 canonical URI the token is bound to
});
export type McpOAuthToken = z.infer<typeof mcpOAuthTokenSchema>;

// Credentials for installing atoms from private sources. Secrets in auth.json, never config.json.
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

export const providerSchema = z.object({
  id: z.string(), // also the credentialPool bucket key in auth.json
  label: z.string(),
  type: providerTypeSchema,
  baseUrl: httpUrlSchema.optional(), // required for openai-compatible & cloudflare-gateway; optional override elsewhere
  extra: z.record(z.string(), z.string()).optional(), // free-form provider knobs (e.g. cloudflare account id / gateway slug)
  // Absent/true = enabled, for stored providers predating this field. Not yet enforced by the
  // model-routing/dispatch layer — see docs on POST /model/providers/:id/enable|disable.
  enabled: z.boolean().optional()
});

export type Provider = z.infer<typeof providerSchema>;

const generationParamsSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
    topP: z.number().min(0).max(1).optional(),
    reasoningEffort: z.string().optional()
  })
  .strict();

export const profileSchema = z.object({
  alias: z.string(),
  routes: modelProfileRoutesSchema,
  params: generationParamsSchema.default({}),
  routeParams: z.partialRecord(modelRoleSchema, generationParamsSchema).optional(),
  fallbacks: z.array(fallbackTargetViewSchema).default([])
});

export type ModelProfile = z.infer<typeof profileSchema>;

export const agentConfigSchema = z.object({
  id: agentIdSchema,
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
  /** One-line description — drives delegation routing. */
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
  /** Per-agent A2A (Agent2Agent) exposure. Off by default; when enabled the daemon serves a
   *  standard A2A surface scoped to this agent's id. */
  a2a: a2aAgentSettingsSchema.default({ enabled: false }),
  /** Per-agent Monadix consumer opt-in: exposes the `monadix__*` tools to this agent (gated behind
   *  the daemon-level `monadix.enabled` login). The provider (publish) direction is `visibility.public`. */
  monadix: monadixAgentSettingsSchema.default({ consume: false }),
  /** Populated per-agent when this agent is published to Monadix as its own provider; absent until then. */
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
  url: httpUrlSchema,
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

export const externalAgentSchema = externalAgentViewSchema;
export type ExternalAgentConfig = z.infer<typeof externalAgentSchema>;

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
    allowedOrigins: z.array(httpOriginSchema).optional(),
    blockedOrigins: z.array(httpOriginSchema).optional(),
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

// Monadix integration preset. Monadix is the first-party cross-owner A2A collaboration network
// (same company as monad). When enabled, the daemon auto-connects a synthesized HTTP MCP server
// named "monadix" pointed at the first-party endpoint (OAuth), so the agent can delegate OUT to the
// network — no manual mcpServers entry. A single `monad monadix login` authorizes BOTH this consumer
// path and the provider (publish) path; the token lives in auth.json (mcpOAuth["monadix"]), never
// config.json. An operator-defined mcpServers entry named "monadix" takes precedence and this preset
// steps aside (same rule as browser/computer). `baseUrl` overrides the endpoint for staging/self-host.
export const monadixConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Override the Monadix MCP endpoint (default is the first-party production URL). */
    baseUrl: httpUrlSchema.optional(),
    /** OAuth flow: 'loopback' (desktop, default) or 'device' (RFC 8628, headless daemons). */
    flow: z.enum(['loopback', 'device']).optional(),
    /** Auto-approve read-only Monadix tools (discovery/status reads); spend/dispatch tools
     *  (publish_conversation, delegate_to_provider, send_message, …) always route through the
     *  approval gate. Default-on; set false to gate everything. */
    autoApproveReadOnly: z.boolean().optional(),

    // Provider side (native-realtime, per-agent):
    // `monadix.enabled` is the daemon-level master (login + creds). The provider direction is opt-in
    // PER AGENT via `agent.visibility.public`: each public agent dials OUT to Monadix's Supabase
    // Realtime (no public URL / tunnel), auto-registers as its own provider (framework `monad`), and
    // serves inbound tasks routed to that agent. Supabase creds are auto-fetched from the network's
    // public `/realtime/config`; the two fields below only override that for staging/self-host.
    /** Override the Monadix Supabase project URL (default: auto-fetched from the network). */
    supabaseUrl: httpUrlSchema.optional(),
    /** Override the Monadix Supabase anon key (public credential; default: auto-fetched). */
    supabaseAnonKey: z.string().optional()
  })
  .default({ enabled: false });
export type MonadixConfig = z.infer<typeof monadixConfigSchema>;

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
export const peerSchema = z.object({
  id: peerIdSchema,
  label: z.string().min(1),
  /** Remote daemon's OpenAI-compat base, e.g. https://host:port/openai (no trailing /v1). */
  baseUrl: httpUrlSchema,
  /** Default target agent on the peer (name or agt_ id) when the model omits one. */
  defaultAgent: z.string().default('default'),
  /** Token reference: `${secret:peer/<id>/token}` (auth.json) or `${env:NAME}`. */
  tokenRef: z.string(),
  /** Created disabled; enabled once a token is set so the tool only offers usable peers. */
  enabled: z.boolean().default(false)
});
export type PeerConfig = z.infer<typeof peerSchema>;

export const channelInstanceSchema = z.object({
  id: channelIdSchema,
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
  // Group behaviour: by default the bot only answers in a group when addressed (mention/reply).
  // Optional for back-compat — the core resolves an absent policy to requireMention=true.
  groupPolicy: channelGroupPolicySchema.optional(),
  /** Per-channel system-prompt hint injected into this channel's sessions. */
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
export const hooksConfigSchema = z.object({
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
    // How deep the consolidation pipeline runs: 1 = facts only (L1 dedup), 2 = + knowledge graph (L2),
    // 3 = + inferred laws (L3). `/consolidate` and the opt-in background timer process up to this level;
    // each layer past 1 costs an extraction LLM call. Default 1 (cheap, no model cost).
    level: z.number().int().min(1).max(3).default(1),
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
    // Opt-in background consolidation. Off by default — when on, the daemon runs the full pipeline
    // (to `level`) every `intervalMinutes` so memory stays fresh (each layer past L1 costs an
    // extraction LLM call per session with new prose). Manual /consolidate works regardless.
    graph: z
      .object({
        autoConsolidate: z.boolean().optional(),
        intervalMinutes: z.number().int().positive().optional()
      })
      .optional(),
    // Temporal decay of L3 laws (read-time, no LLM). A law's confidence fades with age since it was
    // last re-derived; `floor` (0-1) suppresses a decayed law from recall. Defaults: 365d half-life,
    // floor 0 (decay visible but never suppresses until you raise the floor).
    decay: z
      .object({
        halfLifeDays: z.number().positive().optional(),
        floor: z.number().min(0).max(1).optional()
      })
      .optional()
  })
  .default({ backend: 'builtin', level: 1, mem0: {} });
export type MemorySettings = z.infer<typeof memorySettingsSchema>;

// Context-window management: the cascade that keeps a turn's prompt within the model's window.
// The defaults define the shipped cascade behavior (lossless eviction on, background compaction on).
// To revert an individual stage to pre-cascade behavior, disable it explicitly: `eviction.enabled`
// false drops the lossless stage, `summarize.background` false makes compaction synchronous again.
// Fractions are of the active model's context limit.
export const contextSettingsSchema = z
  .object({
    // Stage 1 — lossless: once the window crosses `atFraction`, replace OLD tool-result outputs with
    // a short pointer placeholder (the model can re-run the tool), keeping the most recent
    // `keepRecentRounds` tool rounds verbatim (a round = one assistant→tools step, kept whole even
    // when it fired parallel calls). Only fires when a pass reclaims ≥ `clearAtLeast` tokens, and
    // skips results smaller than `minResultTokens`.
    eviction: z
      .object({
        enabled: z.boolean().default(true),
        atFraction: z.number().min(0).max(1).default(0.5),
        keepRecentRounds: z.number().int().min(0).default(3),
        clearAtLeast: z.number().int().min(0).default(2000),
        minResultTokens: z.number().int().min(0).default(200)
      })
      .default({ enabled: true, atFraction: 0.5, keepRecentRounds: 3, clearAtLeast: 2000, minResultTokens: 200 }),
    // Stage 2 — lossy: fold older turns into a durable rolling summary at `softFraction`; a per-step
    // hard truncation guard at `hardFraction` keeps the window from overflowing mid tool-loop.
    // `background` runs soft-threshold compaction non-blocking (Mastra-style): the turn proceeds with
    // the full window and the durable summary lands on a later turn; a turn at/over `hardFraction`
    // waits for any in-flight compaction, then compacts synchronously if still over.
    summarize: z
      .object({
        softFraction: z.number().min(0).max(1).default(0.6),
        hardFraction: z.number().min(0).max(1).default(0.9),
        background: z.boolean().default(true)
      })
      .default({ softFraction: 0.6, hardFraction: 0.9, background: true }),
    // Stage 3 — re-anchor the current plan after compaction (implemented in a later phase).
    recitation: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
    // Promote durable facts out of compacted spans: off | suggest (propose, user confirms) | auto.
    memoryPromotion: z.object({ mode: z.enum(['off', 'suggest', 'auto']).default('off') }).default({ mode: 'off' }),
    // Nudge the user to hand off to a fresh session past `atFraction` at a task boundary.
    handoffNudge: z
      .object({ enabled: z.boolean().default(false), atFraction: z.number().min(0).max(1).default(0.7) })
      .default({ enabled: false, atFraction: 0.7 })
  })
  .default({
    eviction: { enabled: true, atFraction: 0.5, keepRecentRounds: 3, clearAtLeast: 2000, minResultTokens: 200 },
    summarize: { softFraction: 0.6, hardFraction: 0.9, background: true },
    recitation: { enabled: false },
    memoryPromotion: { mode: 'off' },
    handoffNudge: { enabled: false, atFraction: 0.7 }
  });
export type ContextSettings = z.infer<typeof contextSettingsSchema>;
