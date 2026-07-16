import {
  a2aAgentSettingsSchema,
  agentAtomsSchema,
  agentIdSchema,
  agentVisibilitySchema,
  fallbackTargetViewSchema,
  hookMatcherSettingSchema,
  httpOriginSchema,
  httpUrlSchema,
  modelKindSchema,
  modelProfileRoutesSchema,
  modelRoleSchema,
  modelRolesSchema,
  monadixAgentSettingsSchema,
  KNOWN_PROVIDER_TYPES as PROTOCOL_KNOWN_PROVIDER_TYPES,
  sandboxBackendRefSchema,
  sandboxModeSchema
} from '@monad/protocol';
import { z } from 'zod';

import { runtimeSchemaUrl, sourceSchemaUrl, toMonadJsonSchema } from './schema-json.ts';

export const CURRENT_AGENTS_VERSION = 1;

const sandboxCredentialTransformSchema = z.object({
  extract: z.string().min(1).max(4096).optional(),
  maskDuplicates: z.boolean().optional(),
  decode: z.literal('jwt').optional(),
  maskClaims: z.array(z.string().min(1).max(128)).max(32).optional()
});

const sandboxCredentialSchema = z
  .object({
    name: z.string().min(1).max(128),
    injectHosts: z.array(z.string().min(1).max(253)).min(1).max(64),
    value: z.string().optional(),
    file: z.string().optional(),
    extract: z.string().min(1).max(4096).optional(),
    transform: sandboxCredentialTransformSchema.optional()
  })
  .superRefine((credential, ctx) => {
    const normalizedTransform = {
      ...credential.transform,
      ...(credential.extract === undefined ? {} : { extract: credential.extract })
    };
    if ((credential.value === undefined) === (credential.file === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'each sandbox credential must set exactly one of `value` or `file`'
      });
    }
    if (credential.extract !== undefined && credential.transform?.extract !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['extract'], message: 'set extract in only one location' });
    }
    if (normalizedTransform.maskDuplicates && !normalizedTransform.extract) {
      ctx.addIssue({
        code: 'custom',
        path: ['transform', 'maskDuplicates'],
        message: 'maskDuplicates requires extract'
      });
    }
    if (normalizedTransform.maskClaims && normalizedTransform.decode !== 'jwt') {
      ctx.addIssue({ code: 'custom', path: ['transform', 'maskClaims'], message: 'maskClaims requires decode: jwt' });
    }
    if (
      normalizedTransform.maskClaims &&
      new Set(normalizedTransform.maskClaims).size !== normalizedTransform.maskClaims.length
    ) {
      ctx.addIssue({ code: 'custom', path: ['transform', 'maskClaims'], message: 'maskClaims must be unique' });
    }
  })
  .transform(({ extract, transform, ...credential }) => {
    const normalized =
      transform === undefined && extract === undefined
        ? undefined
        : { ...transform, ...(extract === undefined ? {} : { extract }) };
    return { ...credential, ...(normalized === undefined ? {} : { transform: normalized }) };
  });

// Sandbox policy is exposed at `cfg.sandbox` and persisted with other agent infrastructure.
// (confine=true, net='unrestricted', backend='auto'). The org ceiling (`agent.globalSandbox`) is a
// separate concern and stays in config.json.
export const sandboxConfigSchema = z.object({
  // Defaulted to the safe 'workspace' jail so partial in-process construction remains fail-safe.
  // policy (matches createDefaultConfig + globalSandbox's default mode). The original nested schema
  // left this required because config.json always carried it; a standalone file must self-default.
  mode: sandboxModeSchema.default('workspace'),
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
  // Egress denylist for net:'filtered' — a deny match wins over allowedDomains (even over '*').
  deniedDomains: z.array(z.string()).default([]),
  // net:'filtered' TLS termination. Off (default) → HTTPS through the proxy stays an opaque CONNECT
  // tunnel. On → the proxy decrypts, inspects, and re-issues HTTPS with a MITM CA (the child trusts
  // it via injected trust env; the proxy→server leg keeps real cert validation). Foundation for
  // path-level filtering and credential-sentinel substitution. caCertPath/caKeyPath supply a
  // persistent CA (must be given together); absent → an ephemeral per-run CA is generated.
  tlsTerminate: z
    .object({
      enabled: z.boolean().default(false),
      caCertPath: z.string().optional(),
      caKeyPath: z.string().optional()
    })
    .default({ enabled: false }),
  // Credential-sentinel injection. Each entry masks a secret so the confined child sees a fake
  // `fake_value_…` sentinel, and the TLS-terminating proxy swaps sentinel→real on the outbound
  // request ONLY when the destination host matches that credential's `injectHosts` (exact or
  // subdomain). An exfil to any other host carries the useless fake. An entry is EITHER:
  //   • env  — `value` set: the child gets `name=<sentinel>` in its environment. `value` is a raw
  //            value or a `${secret:NAME}` / `${env:NAME}` ref (resolved daemon-side).
  //   • file — `file` set: the credential lives in a file on disk; the child reads a sentinel from
  //            the file (via a read-only bind over it) instead of the real content. `extract` (a
  //            regex whose capture group 1 is the credential value) masks only the matched span(s)
  //            so JSON/YAML/.netrc stays valid; without it the whole file is masked. Enforced only
  //            on launchers that can redirect a read (Linux + bwrap); Seatbelt/AppContainer degrade
  //            to DENY (file unreadable); Landlock/Low-IL cannot enforce and warn.
  // REQUIRES net:'filtered' AND tlsTerminate.enabled — without MITM the proxy cannot see HTTPS
  // headers, so sentinels never apply to HTTPS. Empty (default) → no masking.
  credentials: z.array(sandboxCredentialSchema).max(64).default([]),
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
  // macOS VM backend (backend:'vm') tuning. One Fedora CoreOS VM per agent (own kernel/fs/pids),
  // reused across the agent's sessions; see docs. All fields optional (sensible defaults).
  vm: z
    .object({
      // Reuse granularity: 'agent' (one VM shared across an agent's sessions) or 'session'.
      scope: z.enum(['agent', 'session']).default('agent'),
      // Keep an idle VM this long (ms) after its last session ends, for fast reuse. Default 10 min.
      idleTtlMs: z.number().int().positive().default(600_000),
      // Max concurrent VMs; over the cap the least-recently-used idle VM is evicted. Default 8.
      maxInstances: z.number().int().positive().default(8),
      // Per-VM memory (MiB) and vCPUs.
      memory: z.number().int().positive().default(2048),
      cpus: z.number().int().positive().default(2),
      // Attach a memory-balloon device + host-pressure reclaim so idle VMs release pages. Default on.
      balloon: z.boolean().default(true),
      baseline: z
        .object({
          enabled: z.boolean().default(false),
          maxInactiveArtifacts: z.number().int().min(0).max(64).default(4),
          maxBytes: z
            .number()
            .int()
            .min(0)
            .max(256 * 1024 * 1024 * 1024)
            .default(32 * 1024 * 1024 * 1024)
        })
        .default({ enabled: false, maxInactiveArtifacts: 4, maxBytes: 32 * 1024 * 1024 * 1024 }),
      // Explicit vfkit / gvproxy / winvm-helper binary paths (skip host detection + download).
      vfkitPath: z.string().optional(),
      gvproxyPath: z.string().optional(),
      winvmHelperPath: z.string().optional()
    })
    .optional(),
  // Heavy sandbox backend selector. 'auto' (default) uses the light OS launcher (Seatbelt /
  // bwrap / Landlock / AppContainer). 'docker'/'e2b'/'vm' select a heavy launcher, which must be
  // provided by an enabled atom pack (e.g. @monad/monad-power-pack); if unavailable it falls back
  // to the light default.
  backend: z.enum(['auto', 'docker', 'e2b', 'vm']).default('auto'),
  // Source-qualified identity removes ambiguity when two atom packs contribute the same kind.
  // `backend` remains during the compatibility window; config loading migrates it into this field.
  activeBackend: sandboxBackendRefSchema.default({ source: 'builtin', kind: 'auto' }),
  // Host-owned opaque values, keyed by `builtin/<kind>` or `atom-pack/<packId>/<kind>`.
  // Secret fields contain only `${secret:sandbox/...}` references, never plaintext.
  backendSettings: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  // DANGER: when confine=true but no launcher is available, allow children to run unconfined on
  // the host rather than refusing to start. Default is fail-closed. Set to true only when you
  // have intentionally deployed without a sandbox launcher and understand that agent-spawned
  // processes run with full host privileges.
  allowUnconfinedExec: z.boolean().default(false)
});
export type SandboxConfig = z.infer<typeof sandboxConfigSchema>;

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
// disabled while it's active). Hot-reloadable agent preference.
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
// Fractions are of the active model's context limit. Full reference: docs/internals/context-management.md.
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
    // Large tool outputs: the model-visible result is truncated to `maxChars` (head+tail). When
    // `persistRaw` is on, the full pre-truncation output is spilled (capped at `rawCapBytes`) so it
    // can be recovered later by handle instead of re-running the tool.
    toolOutput: z
      .object({
        maxChars: z.number().int().min(0).default(24_000),
        persistRaw: z.boolean().default(true),
        rawCapBytes: z.number().int().min(0).default(2_000_000)
      })
      .default({ maxChars: 24_000, persistRaw: true, rawCapBytes: 2_000_000 }),
    // Stage 3 — re-anchor the current plan (summary's Open Tasks / Next Step) at the end of the
    // prompt after compaction, closest to where the model generates. Opt-in; no-op without a summary.
    recitation: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
    // Promote durable facts out of compacted spans: off | suggest (propose, user confirms) | auto.
    memoryPromotion: z.object({ mode: z.enum(['off', 'suggest', 'auto']).default('off') }).default({ mode: 'off' }),
    // Nudge the user to hand off to a fresh session past `atFraction` at a task boundary.
    handoffNudge: z
      .object({ enabled: z.boolean().default(false), atFraction: z.number().min(0).max(1).default(0.7) })
      .default({ enabled: false, atFraction: 0.7 }),
    // Stage 4 (optional) — semantic retrieval: before a turn, embed the latest user message and
    // search this session's full message history (unaffected by eviction/summarization — the store
    // keeps original text regardless of what's currently sent) for related content, splicing the
    // top hits back onto the end of the prompt. Recovers exactly what the earlier lossy stages can
    // silently discard. Requires an embedding model configured; no-ops otherwise.
    retrieval: z
      .object({
        enabled: z.boolean().default(false),
        minScore: z.number().min(0).max(1).default(0.7),
        maxResults: z.number().int().min(0).max(10).default(3)
      })
      .default({ enabled: false, minScore: 0.7, maxResults: 3 })
  })
  .default({
    eviction: { enabled: true, atFraction: 0.5, keepRecentRounds: 3, clearAtLeast: 2000, minResultTokens: 200 },
    summarize: { softFraction: 0.6, hardFraction: 0.9, background: true },
    toolOutput: { maxChars: 24_000, persistRaw: true, rawCapBytes: 2_000_000 },
    recitation: { enabled: false },
    memoryPromotion: { mode: 'off' },
    handoffNudge: { enabled: false, atFraction: 0.7 },
    retrieval: { enabled: false, minScore: 0.7, maxResults: 3 }
  });
export type ContextSettings = z.infer<typeof contextSettingsSchema>;

const agentToolsSchema = z
  .object({
    shellPath: z.string().optional(),
    gitBashPath: z.string().optional(),
    codeExecBackend: z.string().default('follow-system'),
    codeExecE2b: z.object({ apiKey: z.string() }).optional(),
    codeExecDocker: z.object({ image: z.string().optional() }).optional(),
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
      .default({ backend: 'auto' })
  })
  .default({ codeExecBackend: 'follow-system', webSearch: { provider: 'auto' }, email: { backend: 'auto' } });

export const monadAgentsConfigSchema = z.object({
  version: z.literal(CURRENT_AGENTS_VERSION),
  model: z.object({
    default: z.string(),
    providers: z.array(providerSchema).default([]),
    profiles: z.array(profileSchema).default([]),
    roles: modelRolesSchema.default({}),
    tierOverrides: z.record(z.string(), z.enum(['fast'])).default({}),
    kinds: z.record(z.string(), modelKindSchema).default({})
  }),
  agent: z.object({
    agents: z.array(agentConfigSchema).default([]),
    defaultAgentId: z.string().optional(),
    globalSandbox: z
      .object({ enabled: z.boolean(), mode: sandboxModeSchema })
      .default({ enabled: false, mode: 'workspace' }),
    tools: agentToolsSchema,
    approvals: agentApprovalsSchema
  }),
  sandbox: sandboxConfigSchema.default(() => sandboxConfigSchema.parse({})),
  skills: z
    .object({
      autoload: z.boolean().default(true),
      disabled: z.array(z.string()).default([]),
      autoloadDisabled: z.array(z.string()).default([]),
      installReview: z.boolean().default(false)
    })
    .default({ autoload: true, disabled: [], autoloadDisabled: [], installReview: false }),
  mcpServers: z.array(mcpServerSchema).default([]),
  browser: browserConfigSchema,
  computer: computerConfigSchema,
  obscura: obscuraConfigSchema,
  hooks: hooksConfigSchema.optional(),
  policyHooks: hooksConfigSchema.optional(),
  memory: memorySettingsSchema,
  context: contextSettingsSchema
});
export type MonadAgentsConfig = z.infer<typeof monadAgentsConfigSchema>;

let agentsSchemaUrl = sourceSchemaUrl('agents');

export const AGENTS_SCHEMA_CONTENT = toMonadJsonSchema(monadAgentsConfigSchema);

export function getAgentsSchemaUrl(): string {
  return agentsSchemaUrl;
}

export function setAgentsSchemaRuntimeDir(runtimeDir: string): void {
  if (Bun.env.NODE_ENV !== 'development') agentsSchemaUrl = runtimeSchemaUrl(runtimeDir, 'agents');
}
