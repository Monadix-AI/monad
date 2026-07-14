import type { PrincipalId } from '@monad/protocol';

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  avatarStyleSchema,
  blankableHttpUrlSchema,
  composerSettingsSchema,
  DEFAULT_AVATAR_STYLE,
  DEFAULT_COMPOSER_SETTINGS,
  ModelProviderType,
  modelKindSchema,
  modelRolesSchema,
  KNOWN_PROVIDER_TYPES as PROTOCOL_KNOWN_PROVIDER_TYPES,
  principalIdSchema,
  sandboxBackendRefSchema,
  sandboxModeSchema,
  userAvatarDataUrlSchema
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

import {
  acpAgentSchema,
  agentApprovalsSchema,
  agentConfigSchema,
  browserConfigSchema,
  channelInstanceSchema,
  computerConfigSchema,
  contextSettingsSchema,
  DEFAULT_SAMPLE_PROFILE_ALIAS,
  DEFAULT_SAMPLE_PROVIDER_ID,
  externalAgentSchema,
  hooksConfigSchema,
  mcpServerSchema,
  memorySettingsSchema,
  moConfigSchema,
  obscuraConfigSchema,
  peerSchema,
  profileSchema,
  providerSchema
} from './config-schema.ts';

export * from './config-schema.ts';

// Pre-release: the full schema is a single v1 entry — edit it freely instead of writing
// incremental migrations. When the schema changes post-release: bump the constant, update the
// schema below, drop a new vN.ts in the matching migrations/ subdirectory, and add a test fixture.
export const CURRENT_CONFIG_VERSION = 1;
export const CURRENT_PROFILE_VERSION = 1;

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
  Bun.env.NODE_ENV === 'development' ? pathToFileURL(join(import.meta.dir, '..', '..', 'config.schema.json')).href : '';
let _profileSchemaUrl =
  Bun.env.NODE_ENV === 'development'
    ? pathToFileURL(join(import.meta.dir, '..', '..', 'profile.schema.json')).href
    : '';

export function setSchemaRuntimeDir(runtimeDir: string): void {
  if (Bun.env.NODE_ENV !== 'development') {
    _schemaUrl = pathToFileURL(join(runtimeDir, 'config.schema.json')).href;
    _profileSchemaUrl = pathToFileURL(join(runtimeDir, 'profile.schema.json')).href;
  }
}

/** Current `$schema` URL for config.json ($schema annotation written on save). */
export function getSchemaUrl(): string {
  return _schemaUrl;
}

/** Current `$schema` URL for profile.json ($schema annotation written on save). */
export function getProfileSchemaUrl(): string {
  return _profileSchemaUrl;
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
export const DEFAULT_LOCAL_HTTP_FALLBACK_PORT = 52780;

const localHttpFallbackSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().min(1).max(65535).default(DEFAULT_LOCAL_HTTP_FALLBACK_PORT)
});

const httpsSchema = z.object({
  enabled: z.boolean().default(true)
});

const networkConfigSchema = z
  .object({
    port: z.number().int().min(1).max(65535).default(52749),
    host: z.string().min(1).default('127.0.0.1'),
    // Which socket the LOCAL client dials — daemon always serves both; WS push is always TCP.
    transport: z.enum(['tcp', 'uds']).default(DEFAULT_TRANSPORT),
    // Global HTTPS switch. Keep enabled unless TLS provisioning is broken on this machine.
    https: httpsSchema.default({ enabled: true }),
    remoteAccess: z.object({
      // When true, daemon binds HTTPS to 0.0.0.0 and requires a Bearer token for non-localhost requests.
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
    port: 52749,
    host: '127.0.0.1',
    transport: DEFAULT_TRANSPORT,
    https: { enabled: true },
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

// Sandbox POLICY block. Lives in its own file (sandbox.json) and is exposed at the top level as
// `cfg.sandbox`. Every field defaults, so an absent sandbox.json parses to a fail-safe policy
// (confine=true, net='unrestricted', backend='auto'). The org ceiling (`agent.globalSandbox`) is a
// separate concern and stays in config.json.
export const sandboxConfigSchema = z.object({
  // Defaulted to the safe 'workspace' jail so an absent sandbox.json yields a complete fail-safe
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
  credentials: z
    .array(
      z
        .object({
          name: z.string(),
          injectHosts: z.array(z.string()),
          value: z.string().optional(),
          file: z.string().optional(),
          extract: z.string().optional()
        })
        .refine((c) => (c.value === undefined) !== (c.file === undefined), {
          message: 'each sandbox credential must set exactly one of `value` (env) or `file` (masked file)'
        })
    )
    .default([]),
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

const monadConfigSchema = z.object({
  version: z.literal(CURRENT_CONFIG_VERSION),
  principal: z.object({
    id: principalIdSchema,
    displayName: z.string(),
    verification: z.enum(['unverified', 'email', 'domain', 'attested'])
  }),
  developerMode: z.boolean().default(defaultDeveloperMode),
  user: z
    .object({
      avatarDataUrl: userAvatarDataUrlSchema.nullable().default(null)
    })
    .default({ avatarDataUrl: null }),
  // App-wide presentation settings — not per-user, not restart-required (see AGENTS.md config-vs-env
  // split). Kept separate from `user` so the avatar style picker isn't bundled with profile identity.
  appearance: z
    .object({
      avatarStyle: avatarStyleSchema.default(DEFAULT_AVATAR_STYLE),
      composer: composerSettingsSchema
    })
    .default({ avatarStyle: DEFAULT_AVATAR_STYLE, composer: DEFAULT_COMPOSER_SETTINGS }),
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
        /** Code-execute backend: 'follow-system' delegates to the active OS sandbox launcher; 'docker'/'e2b' force a specific backend. 'local' is a legacy alias for 'follow-system'. */
        codeExecBackend: z.string().default('follow-system'),
        /** E2B code-execute backend credentials. Supports ${env:NAME} secret refs.
         *  TODO(P2): add templateId: z.string().optional() for custom e2b sandbox templates. */
        codeExecE2b: z.object({ apiKey: z.string() }).optional(),
        /** Docker/Podman code-execute backend settings. */
        codeExecDocker: z.object({ image: z.string().optional() }).optional(),
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
      .default({ codeExecBackend: 'follow-system', webSearch: { provider: 'auto' }, email: { backend: 'auto' } }),
    // Operator-set static approval policy (deny/ask/allow tool lists). Participates in the approval
    // engine as immutable source:'operator' rules; deny always wins over runtime allows.
    approvals: agentApprovalsSchema
  }),
  // Sandbox POLICY block — its own file (sandbox.json), top-level in memory. Absent file → schema
  // defaults (fail-safe). Defaulted here so an in-memory parse (migrateConfig) that never sees
  // sandbox.json still fills the fail-safe policy. The org ceiling stays at `agent.globalSandbox`.
  sandbox: sandboxConfigSchema.default(() => sandboxConfigSchema.parse({})),
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
  network: networkConfigSchema,
  mcpServers: z.array(mcpServerSchema).default([]),
  acpAgents: z.array(acpAgentSchema).default([]), // external ACP agents monad can delegate to
  externalAgents: z.array(externalAgentSchema).default([]),
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
  observability: observabilityConfigSchema,
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
  memory: memorySettingsSchema,
  context: contextSettingsSchema
});

export { monadConfigSchema };
export type MonadConfig = z.infer<typeof monadConfigSchema>;

// Contains infrastructure and security settings that require a daemon restart.
export const monadSystemConfigSchema = z.object({
  version: z.literal(CURRENT_CONFIG_VERSION),
  principal: z.object({
    id: principalIdSchema,
    displayName: z.string(),
    verification: z.enum(['unverified', 'email', 'domain', 'attested'])
  }),
  developerMode: z.boolean().default(defaultDeveloperMode),
  network: networkConfigSchema,
  agent: z.object({
    globalSandbox: z
      .object({ enabled: z.boolean(), mode: sandboxModeSchema })
      .default({ enabled: false, mode: 'workspace' }),
    tools: z
      .object({
        shellPath: z.string().optional(),
        gitBashPath: z.string().optional(),
        codeExecBackend: z.string().default('follow-system'),
        codeExecE2b: z.object({ apiKey: z.string() }).optional(),
        codeExecDocker: z.object({ image: z.string().optional() }).optional()
      })
      .default({ codeExecBackend: 'follow-system' }),
    // Operator static approval policy lives in system config (config.json), like mcpServers/acpAgents.
    approvals: agentApprovalsSchema
  }),
  mcpServers: z.array(mcpServerSchema).default([]),
  // External ACP agents are an operator/infra concern (spawn allowlist) → system config, like mcpServers.
  acpAgents: z.array(acpAgentSchema).default([]),
  externalAgents: z.array(externalAgentSchema).default([]),
  // Peer daemons (delegation targets + their credentials) → system config, like acpAgents.
  peers: z.array(peerSchema).default([]),
  observability: observabilityConfigSchema
});
export type MonadSystemConfig = z.infer<typeof monadSystemConfigSchema>;

// Contains business and user-facing settings that hot-reload without restart.
export const monadProfileSchema = z.object({
  version: z.literal(CURRENT_PROFILE_VERSION),
  user: z
    .object({
      avatarDataUrl: userAvatarDataUrlSchema.nullable().default(null)
    })
    .default({ avatarDataUrl: null }),
  appearance: z
    .object({
      avatarStyle: avatarStyleSchema.default(DEFAULT_AVATAR_STYLE),
      composer: composerSettingsSchema
    })
    .default({ avatarStyle: DEFAULT_AVATAR_STYLE, composer: DEFAULT_COMPOSER_SETTINGS }),
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
          codeExecBackend: z.string().default('follow-system'),
          codeExecE2b: z.object({ apiKey: z.string() }).optional(),
          codeExecDocker: z.object({ image: z.string().optional() }).optional()
        })
        .default({ webSearch: { provider: 'auto' }, email: { backend: 'auto' }, codeExecBackend: 'follow-system' })
    })
    .default({
      agents: [],
      tools: { webSearch: { provider: 'auto' }, email: { backend: 'auto' }, codeExecBackend: 'follow-system' }
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
  memory: memorySettingsSchema,
  context: contextSettingsSchema
});
export type MonadProfile = z.infer<typeof monadProfileSchema>;

// Derived from the zod schemas above (not a file import) so a clean checkout needs no generated
// JSON on disk; initMonadHome writes these to runtime/ for editor `$schema` validation.
export const SCHEMA_CONTENT = toMonadJsonSchema(monadSystemConfigSchema);
export const PROFILE_SCHEMA_CONTENT = toMonadJsonSchema(monadProfileSchema);

export function createDefaultConfig(principalId: PrincipalId, displayName: string): MonadConfig {
  return {
    version: CURRENT_CONFIG_VERSION,
    principal: { id: principalId, displayName, verification: 'unverified' },
    user: { avatarDataUrl: null },
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
      https: { enabled: true },
      remoteAccess: { enabled: false, token: null },
      localHttpFallback: { enabled: false, port: DEFAULT_LOCAL_HTTP_FALLBACK_PORT }
    },
    mcpServers: [],
    acpAgents: [],
    externalAgents: [],
    peers: [],
    browser: { enabled: false, vision: false, headless: true },
    computer: { enabled: false, command: 'uvx', args: ['computer-control-mcp@latest'] },
    mo: { enabled: true },
    obscura: { enabled: false, stealth: false },
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
      recitation: { enabled: false },
      memoryPromotion: { mode: 'off' },
      handoffNudge: { enabled: false, atFraction: 0.7 }
    }
  };
}

export * from './config-io.ts';
