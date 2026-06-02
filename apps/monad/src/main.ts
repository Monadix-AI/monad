/**
 * monad — a standalone full-agent runtime daemon.
 *
 * Copyright (c) 2026 Monadix Labs, Inc.
 * Released under the MIT License.
 * See LICENSE in the repository root for the full license text.
 *
 * Transports (clients choose the protocol):
 *   HTTP REST+SSE  http://127.0.0.1:52749            (control ops + event stream, TCP)
 *   HTTP REST+SSE  unix:~/.monad/run/monad.sock      (same Elysia app over a Unix socket — the
 *                                                      low-latency local path the CLI uses)
 *   WebSocket      ws://127.0.0.1:52749/v1/stream    (JSON-RPC framing, server-push, TCP only)
 *   stdio          stdin/stdout                      (NDJSON / JSON-RPC, --stdio only)
 *   ACP            stdin/stdout                      (Agent Client Protocol for editors, --acp;
 *                                                      bidirectional peer — see transports/acp/)
 */

import type { MonadAuth } from '@monad/home';
import type { McpServerStatus, PrincipalId, SessionId } from '@monad/protocol';
import type { AtomConflict } from '@/atoms/resolve.ts';
import type { Tool } from '@/capabilities/tools/types.ts';

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeInitStatus,
  emptyAuth,
  getPaths,
  initMonadHome,
  loadAll,
  loadAuth,
  resolvePeerSecretRef,
  saveProfile
} from '@monad/home';
import { createI18n, defaultLocaleName, loadLocalePacksFromDir } from '@monad/i18n';
import { BUILTIN_LOCALES_DIR } from '@monad/i18n/locale-dir';
import { createLogger } from '@monad/logger';

import { applyAcpDelegateTool } from '@/bootstrap/acp-delegate.ts';
import { authorizeMcpOAuth } from '@/capabilities/mcp/oauth.ts';
import { buildServiceTools, builtinTools, registerSandboxLauncher } from '@/capabilities/tools';
import { ChannelService, type SessionGateway } from '@/channels/channel.ts';
import { AtomPackRegistry } from '@/handlers/atom-pack/index.ts';
import { type CommandBundle, createCommandRegistry } from '@/handlers/commands/index.ts';
import { createDaemonHandlers } from '@/handlers/handlers.ts';
import { createHookRunner, type HookConfig } from '@/hooks/runner.ts';
import { initObservability } from '@/infra/observability.ts';
import { acquireSingletonLock } from '@/infra/singleton-lock.ts';
import { ReloadService } from '@/reload/index.ts';
import { ConfigBus } from '@/services/config-bus.ts';
import { DelegationService } from '@/services/delegation/delegation.ts';
import { createPeerDelegateTool, type PeerDelegateTarget } from '@/services/delegation/peer-delegate.ts';
import { configureDeveloperLogTransport } from '@/services/developer-log.ts';
import { EventBus } from '@/services/event-bus.ts';
import { AgentPersonaService, isToolExposed } from '@/services/generation/agent-persona.ts';
import { I18nService, loadInstalledLocalePacks } from '@/services/i18n.ts';
import { createGraphQueryTools } from '@/services/memory/graph/query-tools.ts';
import { createMemoryAgentTools } from '@/services/memory/tools.ts';
import { RoundCache } from '@/services/round-cache.ts';
import { ScheduleService } from '@/services/scheduling/schedule.ts';
import { ensureDevProvider } from '@/store/home/dev-init.ts';
import { resolveSkillState } from '@/store/home/skills.ts';
import { loadWorkspacePromptSlots, WORKSPACE_CONTEXT_FILES } from '@/store/home/workspace-context.ts';
import { runAcpBridge } from '@/transports/acp/launch.ts';
import { createDaemonAgent } from './bootstrap/agent.ts';
import { createAtomPackRediscoverer } from './bootstrap/atoms.ts';
import { createChannelRegistry } from './bootstrap/channels.ts';
import { createCommandBundle } from './bootstrap/commands.ts';
import { createDataLayer } from './bootstrap/data-layer.ts';
import { createInterruptServices } from './bootstrap/interrupts.ts';
import {
  collectMcpStatus,
  connectFileMcpServers,
  connectMcpServers,
  reconnectOneMcpServer,
  reloadConfigMcpServers
} from './bootstrap/mcp.ts';
import { createMemorySubsystem } from './bootstrap/memory.ts';
import { createModelSubsystem } from './bootstrap/model.ts';
import { createObscuraController } from './bootstrap/obscura.ts';
import { configureDaemonLogging, readDaemonRuntimeFlags } from './bootstrap/runtime-flags.ts';
import { createSandbox, finalizeSandboxLauncher } from './bootstrap/sandbox.ts';
import { serveDaemon } from './bootstrap/serve.ts';
import { createSkillSubsystem } from './bootstrap/skills.ts';
import { createTlsCert } from './bootstrap/tls.ts';
import { configureToolBackends } from './bootstrap/tool-backends.ts';
import { withCredentialsProtection, withSandboxConstraints } from './bootstrap/tool-protection.ts';
import { createUpgradeInfoMonitor } from './bootstrap/upgrade-info.ts';
import { createHttpTransport } from './transports/http.ts';

// Eden type-safe client inference (compile-time only). Derived from the transport factory
// so it stays valid without a module-level app instance.
// NOTE: this import intentionally uses a relative path so tsgo emits a resolvable path in
// dist/main.d.ts — the @/ alias is internal to @monad/monad and would not resolve for
// consumers (e.g. @monad/client) reading the generated d.ts.
export type App = ReturnType<typeof createHttpTransport>;

configureDaemonLogging();
const logger = createLogger('monad-daemon');

export async function startDaemon(opts?: { beforeListen?: (app: App) => void }): Promise<void> {
  const paths = getPaths();

  // ACP mode is a thin BRIDGE: it discovers (or auto-spawns) a shared daemon and proxies the
  // editor's connection to it, so it must NOT take the singleton lock or build a daemon in-process
  // — that lock belongs to the daemon it bridges to. Branch out before any daemon bootstrap.
  if (process.argv.includes('--acp')) {
    await runAcpBridge(paths);
    return;
  }

  // Bootstrap a minimal i18n instance just for the singleton lock error — locale comes from a
  // fast config peek so the error message is localized even before full config loading.
  const earlyLocale = await Bun.file(paths.config)
    .json()
    .then((c: { locale?: string }) => c?.locale ?? 'en')
    .catch(() => 'en');
  const earlyPacks = await loadLocalePacksFromDir(BUILTIN_LOCALES_DIR, defaultLocaleName);
  const earlyI18n = createI18n({ locale: earlyLocale, packs: earlyPacks });
  await acquireSingletonLock(earlyI18n.t, paths.pid);

  const {
    stdioMode: STDIO_MODE,
    stdoutRpc: STDOUT_RPC,
    useMock: USE_MOCK,
    devMode: DEV_MODE,
    devSilent: DEV_SILENT
  } = readDaemonRuntimeFlags();

  await initMonadHome(paths);

  // Prepend ~/.monad/bin to PATH so tools installed during `monad init` are found by MCP spawns.
  // No detection or download here — installation happens interactively via POST /init/env-deps.
  if (existsSync(paths.bin)) {
    const pathSep = process.platform === 'win32' ? ';' : ':';
    Bun.env.PATH = `${paths.bin}${pathSep}${Bun.env.PATH ?? ''}`;
  }

  if ((DEV_MODE || DEV_SILENT) && !USE_MOCK) {
    const seeded = await ensureDevProvider(paths);
    if (seeded.seeded) logger.info(`dev: seeded provider from config.init.json (model ${seeded.model})`);
    else if (seeded.reason === 'no-key') logger.warn('dev: no API key in config.init.json — complete setup at /init');
    else if (seeded.reason === 'no-model') logger.warn('dev: no model in config.init.json — complete setup at /init');
  }

  // KV server + SQLite store with a startup repair pass (see ./bootstrap/data-layer.ts).
  const { kv, store } = await createDataLayer({ paths, devMode: DEV_MODE || DEV_SILENT });

  const cfg = await loadAll(paths.config, paths.profile);
  if (!cfg) throw new Error('monad: config.json missing after repair — aborting');
  configureDeveloperLogTransport(paths, cfg.observability.developerMode === true);
  const ownerPrincipalId = cfg.principal.id as PrincipalId;

  // Bind address: config > default.
  // When remote access is enabled the daemon binds to 0.0.0.0 so other machines
  // can reach it; bearer-token auth in the HTTP transport guards all remote calls.
  const remoteAccess = cfg.network.remoteAccess;
  let _openAiCompatCache: { val: { enabled: boolean; token?: string }; exp: number } | null = null;
  const getOpenAiCompatConfig = async () => {
    if (_openAiCompatCache && Date.now() < _openAiCompatCache.exp) return _openAiCompatCache.val;
    const live = await loadAll(paths.config, paths.profile);
    const val = { enabled: live?.openaiCompat?.enabled ?? false, token: live?.openaiCompat?.token };
    _openAiCompatCache = { val, exp: Date.now() + 1000 };
    return val;
  };
  // MONAD_PORT overrides the configured port (dev: one daemon per git worktree on its own port,
  // assigned by scripts/setup-dev.ts). Clients honour the same var in resolveClientConn so they
  // dial the matching port. Unset in production → falls back to config.json.
  const PORT = Number(Bun.env.MONAD_PORT) || cfg.network.port;
  const HOST = remoteAccess.enabled ? '0.0.0.0' : '127.0.0.1';

  // Load auth once at startup so ${secret:NAME} refs can be resolved during bootstrap (tool
  // backends, MCP server headers). Hot-reload keeps a fresh copy via configBus; this copy is
  // startup-only and intentionally not re-used after that point.
  const startupAuth = (await loadAuth(paths.auth)) ?? undefined;
  await configureToolBackends(cfg, startupAuth);

  // OS confinement + ephemeral session sandboxes (see ./bootstrap/sandbox.ts).
  const { sandboxRoots, sessionSandbox } = await createSandbox(cfg, paths, store, startupAuth);

  const bus = new EventBus();
  const cache = new RoundCache(kv);
  const { oversight, clarify, reloadApprovalPolicy } = await createInterruptServices({ paths, cfg, store, bus });
  // Kill any adapter processes that were live when the daemon last stopped and mark their rows evicted.
  store.reconcileOrphanedDelegates();
  // Clean up evicted delegate rows older than the retention window (7 days).
  const pruned = store.pruneOldAcpDelegates();
  if (pruned > 0) logger.info({ pruned }, 'pruned old acp_delegates rows');
  const delegatePruneTimer = setInterval(
    () => {
      const n = store.pruneOldAcpDelegates();
      if (n > 0) logger.info({ pruned: n }, 'pruned old acp_delegates rows');
    },
    24 * 60 * 60 * 1000
  );
  delegatePruneTimer.unref();
  // Bound native_cli_sessions growth (one row per CLI launch, up to 256 KB snapshot each).
  const prunedNativeCli = store.pruneExitedNativeCliSessions();
  if (prunedNativeCli > 0) logger.info({ pruned: prunedNativeCli }, 'pruned old native_cli_sessions rows');
  const nativeCliPruneTimer = setInterval(
    () => {
      const n = store.pruneExitedNativeCliSessions();
      if (n > 0) logger.info({ pruned: n }, 'pruned old native_cli_sessions rows');
    },
    24 * 60 * 60 * 1000
  );
  nativeCliPruneTimer.unref();
  // Reverse fs/terminal delegation for ACP-bridged sessions. Unlike oversight/clarify, its events are
  // ephemeral RPC — bus-only, NEVER persisted (replaying a delegation request on reconnect is wrong).
  const delegation = new DelegationService({ publish: (event) => bus.publish(event) });
  // Connectors ride in `builtinAtomPack` and register through the atom-kind-gated loader (see
  // buildChannelRegistry below). Tools are NOT atoms: they are always first-party and built into
  // the daemon (@/capabilities/tools), so we wire `builtinTools` straight into the registry here — applying the
  // runtime sandbox + credentials wrap (this is where sandboxRoots and the credentials path live).
  const registry = new AtomPackRegistry();
  for (const tool of builtinTools) {
    registry.registerTool(withCredentialsProtection(withSandboxConstraints(tool, sandboxRoots), paths.credentials));
  }

  // Unified slash-command registry. Built-ins are NOT pre-seeded — they arrive via builtinAtomPack's
  // `command` atoms through the gated loader below (onCommand → registerBuiltin, reserved). Atom-pack
  // commands from third-party discovery route through the same registry (registerAtom).
  const commandRegistry = createCommandRegistry((level, msg) => logger[level](msg));

  // Connect configured + preset MCP servers and register their tools into the registry, so a remote
  // tool rides the same gate + sandbox seam as a built-in (see ./bootstrap/mcp.ts). Held in a mutable
  // handle so a settings hot-reload can diff-reconnect (connect added / disconnect removed / reconnect
  // changed) without a daemon restart — the agent reads tools live from the registry.
  let configMcp = await connectMcpServers(cfg, paths, registry, startupAuth);
  let configMcpHttp = configMcp.seenHttp;
  process.on('exit', () => {
    for (const { conn } of configMcp.connections.values()) void conn.close();
  });

  if (!USE_MOCK) {
    const initStatus = computeInitStatus(cfg, startupAuth ?? null);
    if (!initStatus.initialized) {
      logger.warn(`monad is not initialized — run \`monad init\` or open http://${HOST}:${PORT}/`);
    }
  }

  // Model router/profiles + catalog (pricing/context limits) + background embedding indexer
  // (see ./bootstrap/model.ts). Reuses startupAuth so bootstrap doesn't re-read auth.json.
  const { modelService, modelCatalog, embeddingIndexer } = await createModelSubsystem({
    cfg,
    paths,
    store,
    useMock: USE_MOCK,
    auth: startupAuth ?? null
  });

  const reloadService = new ReloadService({ log: (level, message) => logger[level](message) });
  process.on('exit', () => reloadService.closeAll());

  const discovered = await modelService.discoverProviders(paths.providers);
  if (discovered.errors.length > 0) {
    for (const e of discovered.errors) {
      logger.warn(`monad: provider atom "${e.file}" failed to load: ${e.error}`);
    }
  }
  reloadService.register({
    name: 'providers',
    path: paths.providers,
    filter: (filename) => Boolean(filename?.endsWith('.js')),
    onChange: async () => {
      const res = await modelService.discoverProviders(paths.providers);
      for (const e of res.errors) logger.warn(`monad: provider atom "${e.file}" failed to reload: ${e.error}`);
    }
  });

  // Effective skill state resolver (global master + per-instance switches, overridden by the
  // active agent's switches). A `let` so a config.json edit can swap it in and re-map skills
  // without a restart.
  const computeSkillState = (c: typeof cfg) =>
    resolveSkillState({
      global: c.skills,
      agent: c.agent.agents.find((a) => a.id === c.agent.defaultAgentId)?.skills
    });
  let skillState = computeSkillState(cfg);
  // Command-hook config, swapped in place on a settings reload so config.json `hooks` edits
  // hot-apply without a restart (the HookRunner below reads it via a getter each call).
  let hooksConfig: HookConfig = cfg.hooks ?? {};
  // Operator-managed policy hooks — same hot-swap discipline, but a separate field the hooks
  // settings API never writes, so user edits can't remove an org-enforced rule.
  let policyHooksConfig: HookConfig = cfg.policyHooks ?? {};

  // In-process pub/sub for config/profile changes. Shared by the file-watcher and commit() paths
  // so both trigger the exact same set of reload callbacks.
  const configBus = new ConfigBus((err) => logger.warn(`monad: config-bus listener error: ${err}`));

  // Watch the home dir, not the files directly, so atomic rename-replace writes are caught.
  // Network/sandbox/principal settings are NOT hot-applied (wired at boot) — those need a restart.
  reloadService.register({
    name: 'settings',
    path: paths.home,
    filter: (filename) => filename === 'config.json' || filename === 'profile.json' || filename === 'auth.json',
    onChange: async () => {
      const [freshCfg, freshAuth] = await Promise.all([loadAll(paths.config, paths.profile), loadAuth(paths.auth)]);
      if (!freshCfg) return; // mid-write or temporarily absent — skip this tick
      await configBus.publish({ cfg: freshCfg, auth: freshAuth });
      logger.info('monad: hot-reloaded settings from disk');
    }
  });

  // User-editable prompt slots from the workspace root — SOUL.md, AGENT.md/AGENTS.md, USER.md.
  // A `let` so an edit hot-reloads without rebuilding the agent.
  let workspacePromptSlots = await loadWorkspacePromptSlots(paths.workspace);
  reloadService.register({
    name: 'workspace-context',
    path: paths.workspace,
    filter: (filename) => Boolean(filename && WORKSPACE_CONTEXT_FILES.includes(filename)),
    onChange: async () => {
      workspacePromptSlots = await loadWorkspacePromptSlots(paths.workspace);
      logger.info('monad: hot-reloaded workspace prompt slots (SOUL.md / AGENT.md / USER.md)');
    }
  });

  // Per-agent persona (Studio): each session's bound agent contributes its own AGENT.md as the system
  // prompt, falling back to the global workspace identity. The cache is sync (the loop builds the
  // prompt per turn) and hot-reloads on agents-dir edits; the configBus subscriber re-reads on agent
  // create/rename/delete (an agent's row + dir may have changed).
  const agentPersona = new AgentPersonaService(paths, store);
  await agentPersona.reload(cfg);
  reloadService.register({
    name: 'agent-persona',
    path: paths.agents,
    filter: (filename) => Boolean(filename?.endsWith('AGENT.md')),
    onChange: async () => {
      await agentPersona.reload();
      logger.info('monad: hot-reloaded agent personas (AGENT.md)');
    }
  });

  // Running monad version, for advisory skill `compatibility` checks. Best-effort: a bundled
  // standalone binary may not ship package.json, so we fall back to '0.0.0' (which disables the
  // semver warning — compatibility stays a surfaced advisory, never a hard gate).
  const monadVersion = await Bun.file(join(import.meta.dir, '..', 'package.json'))
    .json()
    .then((p: { version?: string }) => p.version ?? '0.0.0')
    .catch(() => '0.0.0');
  const otelEndpoint = cfg.observability?.endpoint || (DEV_MODE || DEV_SILENT ? 'http://localhost:6006' : '');
  const otelActive = initObservability(otelEndpoint, monadVersion);
  if (otelActive && !cfg.observability?.endpoint) {
    logger.info('monad: OTel auto-enabled for dev — Phoenix UI at http://localhost:6006');
  }

  // Skill discovery + L1/list views + hot-reload, encapsulated (see ./bootstrap/skills.ts). The
  // arrays are mutated in place on reload so the live agent + skills.list reflect edits.
  const { loadedSkills, skillList, skillInstances, discoverProjectSkills, reloadSkills } = await createSkillSubsystem({
    paths,
    reloadService,
    monadVersion,
    skillState: (skill) => skillState(skill)
  });

  const agentModel = USE_MOCK ? (await import('@/infra/mock-model.ts')).mockModel() : modelService.router;

  // Discover atom packs (built-in + ~/.monad/atoms) through the atom-kind-gated loader BEFORE the
  // agent snapshots its tools below — so a third-party atom pack's declared tools/connectors reach
  // the agent. Channel factories are collected for the channel gateway (constructed later). An atom
  // pack that registers an undeclared atom kind is rejected here (UndeclaredAtomError), per pack.
  let sessionGateway: SessionGateway | null = null;
  // builtinAtomPack and discovered third-party packs load through the SAME gated loader, but route to
  // slightly different sinks: first-party tools get the sandbox/credentials wrap and first-party
  // commands are reserved (registerBuiltin); third-party commands are attributed + non-reserved
  // (registerAtom). locale/skill/mcp are file-based and do NOT flow through sinks here.
  // Provider types are globally unique: a discovered pack may not redefine a first-party provider
  // (no shadowing `openai` etc.). createChannelRegistry derives the reserved set from whatever the
  // built-in pack registers in its (earlier) load pass — no separately-imported provider list.
  // Bare-name collisions surfaced from the latest load sweep (channel/connector/command),
  // mutated in place so the read accessor handed to the atoms module stays valid across re-discovery.
  const atomConflicts: AtomConflict[] = [];
  const channelRegistry = await createChannelRegistry(paths, {
    builtin: {
      onConnector: (c) => registry.registerConnector(c),
      // First-party commands are reserved (non-overridable). atomPackName is ignored — they are built-ins.
      onCommand: (_atomPackName, cmd) =>
        commandRegistry.registerBuiltin(cmd as Parameters<typeof commandRegistry.registerBuiltin>[0]),
      onProvider: (p) => modelService.registry.register(p),
      onHook: (h) => registry.registerHook(h),
      // Built-in sandbox launchers (Seatbelt/Landlock/Low-Integrity) register into the launcher
      // registry; finalizeSandboxLauncher() below picks one per platform. Boot-only: not wired into
      // the rediscovery sweep, so a hot-installed launcher takes effect on the next daemon start.
      onSandbox: (l) => registerSandboxLauncher(l, 'builtin')
    },
    discovered: {
      onConnector: (c) => registry.registerConnector(c),
      // Third-party atom commands register through the SAME registry as built-ins; built-in
      // names are reserved, so an atom cannot shadow /reset, /model, etc. (rejected + warned).
      onCommand: (atomName, cmd) => commandRegistry.registerAtom(atomName, cmd),
      // An atom declaring the `provider` capability registers its model providers into the model
      // registry — the same path first-party providers take, no special privilege. Globally unique:
      // a type already owned by a built-in (the reserved set createChannelRegistry derives from the
      // built-in pass) is a hard error, not an override.
      onProvider: (p) => modelService.registry.register(p),
      // Namespace-coexist pins: bare name resolves to the user pin (atomPins.<kind>) or first-wins.
      channelPins: cfg.atomPins.channel,
      connectorPins: cfg.atomPins.connector,
      onCollision: (c) => atomConflicts.push(c),
      // An atom pack declaring the `hook` capability registers lifecycle hooks into the registry,
      // which the HookRunner reads alongside config.json command hooks.
      onHook: (h) => registry.registerHook(h),
      // A discovered pack declaring the `sandbox` capability (e.g. a cloud e2b/Vercel launcher)
      // registers into the launcher registry, preferred over built-ins on select.
      onSandbox: (l) => registerSandboxLauncher(l, 'atom')
    }
  });
  // Resolve bare atom-command names to one winner (pin ?? first-wins); each is always reachable as
  // /<packId>.<command> regardless. Built-in reserved names are untouched.
  commandRegistry.resolvePins(cfg.atomPins.command, (c) => atomConflicts.push(c));
  // The sandbox launcher atoms have now registered (built-in pack + any discovered pack) — select
  // the one that confines spawned children for this platform and wire it into the spawn seam.
  finalizeSandboxLauncher(cfg);
  // Locale gateway: file-scan loading from the builtin locale dir + any installed atom-pack locale
  // dirs (~/.monad/locales/<packName>/<lng>/<namespace>.json). Third-party packs override the
  // built-in for the same tag (first discovered per tag wins across pack directories).
  const builtinLocalePacks = await loadLocalePacksFromDir(BUILTIN_LOCALES_DIR, defaultLocaleName);
  const installedLocalePacks = await loadInstalledLocalePacks(paths.packs, paths.locales, defaultLocaleName);
  const i18nService = new I18nService([...builtinLocalePacks, ...installedLocalePacks], cfg.locale);

  // File/pack MCP servers, in a mutable handle so rediscovery can close the previous round before
  // reconnecting — an installed/removed atoms/mcp server takes effect hot (the agent reads its tools
  // live from the registry, so re-registered MCP tools reach it on the next turn, no restart).
  let fileMcpConnections = await connectFileMcpServers(paths, registry, startupAuth, configMcpHttp);
  const reconnectFileMcp = async (): Promise<void> => {
    for (const conn of fileMcpConnections) void conn.close();
    registry.clearToolsFrom('file-mcp'); // drop the previous round so a removed server's tools vanish
    fileMcpConnections = await connectFileMcpServers(paths, registry, startupAuth, configMcpHttp);
  };
  process.on('exit', () => {
    for (const conn of fileMcpConnections) void conn.close();
  });

  // LIVE base tools: a getter (not a snapshot) so a hot-installed atom-pack/MCP tool — which
  // rediscovery re-registers into this same registry — reaches the running agent without a restart.
  // toolList() returns a cached array (rebuilt only on a tool-set change) and toolRevision bumps on
  // every change, so the agent can memoize and skip the per-turn rebuild when nothing was installed.
  const baseTools = (): Tool[] => registry.toolList();
  // Scheduled runs. The fire callback is wired after `handlers` exists (it reuses the session
  // create/generate handlers); until then it is a no-op, which is safe because no timer can
  // fire before load() below.
  let runScheduled: (prompt: string, sessionId: string | undefined) => Promise<void> = async () => {};
  const schedule = new ScheduleService({
    storePath: join(paths.runtime, 'schedules.json'),
    fire: (prompt, sessionId) => runScheduled(prompt, sessionId),
    log: (m) => logger.info(m)
  });

  // Live config + auth holder. A hot-reload (settings edit, credential change, model swap) updates
  // these in place via configBus; subsystems read them through getters so changes take effect without
  // a rebuild. mem0 selects its LLM + embedder FROM this config (no env vars).
  let liveCfg = cfg;
  let liveAuth: MonadAuth | null = startupAuth ?? null;
  configBus.subscribe(({ cfg: fresh, auth }) => {
    liveCfg = fresh;
    liveAuth = auth;
  });

  // Memory subsystem: auto-memory note store, layered L1 memory service (mem0 + daemon-managed local
  // qdrant), L2 knowledge graph + background consolidation, the read-only mem0 explorer, and memory
  // settings write-back, with the lifecycle hooks registered (see ./bootstrap/memory.ts).
  const {
    noteStore,
    memoryService,
    graphStore,
    graphScopesFor,
    runGraphConsolidate,
    getMem0Data,
    memorySetBackend,
    memorySetMem0Models
  } = createMemorySubsystem({
    store,
    paths,
    port: PORT,
    router: agentModel,
    registry,
    configBus,
    liveCfg: () => liveCfg,
    liveAuth: () => liveAuth
  });

  // Lifecycle hooks: config.json command hooks (shell) + any atom-pack-registered in-process hooks,
  // behind one runner. cwd = the sandbox root so command hooks resolve relative paths predictably.
  const hooksLog = createLogger('hooks');
  const hookRunner = createHookRunner({
    config: () => hooksConfig,
    policy: () => policyHooksConfig,
    atomHooks: registry.hooks,
    cwd: sandboxRoots?.[0] ?? paths.workspace,
    log: hooksLog,
    // Audit/metrics seam: every executed hook lands here. deny/ask are info (a real decision was
    // made); allow/mutate are debug to keep the hot path quiet unless explicitly traced.
    record: (e) => {
      const level = e.outcome === 'deny' || e.outcome === 'ask' || e.outcome === 'timeout' ? 'info' : 'debug';
      hooksLog[level](
        {
          event: e.event,
          source: e.source,
          label: e.label.slice(0, 200),
          outcome: e.outcome,
          durationMs: e.durationMs,
          reason: e.reason
        },
        'hook ran'
      );
    }
  });

  // monad-as-ACP-client: register `agent_acp_delegate` into the LIVE registry (not extraTools) so an
  // invite/edit/remove of an external ACP agent takes effect without a restart — re-applied on every
  // configBus publish below. Mounted only when ≥1 agent is enabled (an empty roster advertises nothing).
  applyAcpDelegateTool({
    registry,
    agents: cfg.acpAgents,
    gate: oversight.gate,
    mcpServers: cfg.mcpServers,
    auth: startupAuth,
    store
  });

  // monad-as-peer-client: expose `agent_peer_delegate` only for enabled peers whose token resolves
  // (a peer configured but missing its auth.json credential is skipped, not fatal). The peer runs the
  // subtask self-contained over its OpenAI-compat API; see ./services/peer-delegate.ts.
  const peerTargets: PeerDelegateTarget[] = [];
  for (const p of cfg.peers.filter((x) => x.enabled)) {
    try {
      const token = resolvePeerSecretRef(p.tokenRef, startupAuth ?? emptyAuth());
      peerTargets.push({ id: p.id, label: p.label, baseUrl: p.baseUrl, defaultAgent: p.defaultAgent, token });
    } catch (err) {
      logger.warn({ peer: p.id, err: String(err) }, 'skipping peer with unresolved token');
    }
  }
  const peerDelegateTools =
    peerTargets.length > 0 ? [createPeerDelegateTool({ peers: peerTargets, gate: oversight.gate })] : [];

  // Inbound (peer-delegation) approval policy — read live by the agent's gate; hot-reloaded below.
  let inboundApprovalMode = cfg.openaiCompat.approval;

  // Agent assembly: context window + durable history + model-derived tools + repos (see
  // ./bootstrap/agent.ts). Schedule/memory/acp-delegate tools are wired here and passed in.
  const { agent, history } = createDaemonAgent({
    agentModel,
    modelService,
    modelCatalog,
    store,
    embeddingIndexer,
    cfg,
    paths,
    sandboxRoots,
    oversight,
    clarify,
    loadedSkills,
    baseTools,
    toolsVersion: () => registry.toolRevision,
    extraTools: [
      ...buildServiceTools({ notes: noteStore, scheduler: schedule }),
      ...createMemoryAgentTools(memoryService),
      ...createGraphQueryTools(graphStore, graphScopesFor),
      ...peerDelegateTools
    ],
    delegatableAgents: () => agentPersona.delegatableAgents(),
    toolSourceName: (name) => registry.sourceNameOf(name),
    hookRunner,
    // Live so a profile.json/settings edit to the policy hot-applies (updated by the configBus subscriber).
    inboundApproval: () => inboundApprovalMode,
    workspacePromptSlots: (sessionId) => ({
      ...workspacePromptSlots,
      agent: agentPersona.resolve(sessionId) ?? workspacePromptSlots.agent
    })
  });

  // Backend for the unified slash commands — model list/switch, /compact, /handoff, memory + graph
  // consolidation, and the highRisk approval gate (see ./bootstrap/commands.ts). sessionGateway is
  // late-bound (wired after handlers exist), so it is passed as a getter that /handoff guards on.
  const commandBundle: CommandBundle = createCommandBundle({
    commandRegistry,
    skills: () => skillList,
    store,
    cfg,
    modelService,
    modelCatalog,
    agentModel,
    history,
    memoryService,
    runGraphConsolidate,
    oversight,
    i18n: i18nService,
    bus,
    sessionGateway: () => sessionGateway,
    logger
  });

  // Channel gateway: external IM platforms (Telegram, …) as an inbound transport. It CALLS the
  // session handlers (createForPrincipal + sendInline), wired via the late-bound sessionGateway ref
  // (declared above with the early atom pack discovery). The atom pack contract is narrow by design —
  // adapters never see a sessionId; the core owns conversation→session.
  const channelService = new ChannelService(
    {
      session: {
        // Guard-narrows sessionGateway to non-null (it is wired before start() runs). A throw
        // also resists a linter "fix" that would rewrite a `!` assertion into an unsafe `?.`.
        createForPrincipal: (a) => {
          if (!sessionGateway) throw new Error('channel gateway used before session wiring');
          return sessionGateway.createForPrincipal(a);
        },
        sendInline: (a, sink) => {
          if (!sessionGateway) throw new Error('channel gateway used before session wiring');
          return sessionGateway.sendInline(a, sink);
        },
        reset: (a) => {
          if (!sessionGateway?.reset) throw new Error('channel gateway used before session wiring');
          return sessionGateway.reset(a);
        },
        setWorkspace: (a) => {
          if (!sessionGateway?.setWorkspace) throw new Error('channel gateway used before session wiring');
          return sessionGateway.setWorkspace(a);
        }
      },
      store,
      registry: channelRegistry,
      bus,
      t: i18nService.t,
      commands: commandBundle,
      log: { info: (m) => logger.info(m), warn: (m) => logger.warn(m), error: (m) => logger.error(m) }
    },
    cfg,
    (await loadAuth(paths.auth)) ?? emptyAuth()
  );

  // Wire configBus subscribers now that all services are in scope. The bus fires on both
  // file-watcher events (disk edits) and in-process commit() calls (settings API).
  configBus.subscribe(async ({ cfg: freshCfg, auth: freshAuth }) => {
    const prevEmbedding = modelService.embeddingModel;
    configureDeveloperLogTransport(paths, freshCfg.observability.developerMode === true);
    // Hot-apply the inbound-delegation approval policy (the agent gate reads this live).
    inboundApprovalMode = freshCfg.openaiCompat.approval;
    modelService.reload(freshCfg, freshAuth);
    // Agents may have been created/renamed/deleted — re-read their personas against the fresh config.
    await agentPersona.reload(freshCfg);
    // A newly-configured (or changed) embedding role should backfill existing messages.
    embeddingIndexer.kick();
    // The web UI offers a keep/re-index choice when switching embedding models, but a direct
    // config.json/CLI edit bypasses it — warn so stale vectors (built with the old model) don't
    // silently degrade semantic recall. The user can POST …/embeddings/reindex to rebuild.
    const nextEmbedding = modelService.embeddingModel;
    if (prevEmbedding && nextEmbedding && prevEmbedding !== nextEmbedding) {
      const stale = store.staleEmbeddingCount(nextEmbedding.split(':').slice(1).join(':') || nextEmbedding);
      if (stale > 0) {
        logger.warn(
          `monad: embedding model changed (${prevEmbedding} → ${nextEmbedding}); ${stale} existing ` +
            'embedding(s) are stale. Re-index from model settings (or POST /v1/settings/model/embeddings/reindex).'
        );
      }
    }
    // Hot-apply skill auto-load switches: recompute the predicate and re-map skills in place.
    skillState = computeSkillState(freshCfg);
    await reloadSkills();
    // Hot-reload the channel gateway (connect added, disconnect removed, reconnect changed).
    await channelService
      .reload(freshCfg, freshAuth ?? emptyAuth())
      .catch((err: unknown) => logger.warn(`monad: channel reload failed: ${err}`));
    // Diff-reconnect config.json + preset MCP servers (connect added, disconnect removed, reconnect
    // changed) so a settings edit applies without a restart. Unchanged servers keep their live
    // subprocess/session — a model-only edit (which also fires this) bounces nothing.
    try {
      configMcp = await reloadConfigMcpServers(
        configMcp.connections,
        freshCfg,
        paths,
        registry,
        freshAuth ?? undefined
      );
      configMcpHttp = configMcp.seenHttp;
    } catch (err) {
      logger.warn(`monad: MCP reload failed: ${err}`);
    }
    // Re-apply the acp-delegate tool from the fresh roster so an invite/edit/enable/disable/remove of
    // an external ACP agent takes effect live — same registry-revision bump as the MCP reload above.
    // Guarded so an unexpected failure here can't abort the remaining hot-reload steps below.
    try {
      applyAcpDelegateTool({
        registry,
        agents: freshCfg.acpAgents,
        gate: oversight.gate,
        mcpServers: freshCfg.mcpServers,
        auth: freshAuth ?? undefined,
        store
      });
    } catch (err) {
      logger.warn(`monad: acp-delegate reload failed: ${err}`);
    }
    // Hot-swap operator approval policy — the engine reads operatorRules via a getter each decision.
    reloadApprovalPolicy(freshCfg.agent.approvals);
    // Swap the command-hook config in place — the HookRunner reads it via a getter each call.
    hooksConfig = freshCfg.hooks ?? {};
    policyHooksConfig = freshCfg.policyHooks ?? {};
    i18nService.reload(freshCfg);
    await configureToolBackends(freshCfg, freshAuth ?? undefined);
  });

  // Auto-generated self-signed TLS for remote access; best-effort with HTTP fallback (see
  // ./bootstrap/tls.ts).
  const {
    cert: tlsCert,
    fingerprint: tlsFingerprint,
    expiry: tlsCertExpiry,
    warnings: daemonWarnings
  } = await createTlsCert({
    enabled: remoteAccess.enabled,
    tlsDir: paths.tls,
    allowInsecureHttp: remoteAccess.allowInsecureHttp
  });

  const rediscoverAtomPacks = createAtomPackRediscoverer({
    paths,
    fallbackAtomPins: cfg.atomPins,
    atomConflicts,
    commandRegistry,
    toolRegistry: registry,
    modelProviderRegistry: modelService.registry,
    i18nService,
    reconnectFileMcp,
    channelService
  });

  // Optional Obscura stdio MCP server: connect/disconnect/status behind a trust gate (pinned tool-set
  // hash + per-tool auto-approve), one live connection (see ./bootstrap/obscura.ts).
  const { connectObscura, disconnectObscura, getObscuraStatus } = createObscuraController({ registry, log: logger });

  // Live MCP connection health (config + presets + file/pack + obscura), for the status endpoint.
  // Re-reads config off disk so a just-disabled/added server shows even before the next status poll;
  // falls back to the boot config mid-write.
  const getMcpStatus = async (): Promise<McpServerStatus[]> => {
    const live = (await loadAll(paths.config, paths.profile)) ?? cfg;
    return collectMcpStatus({
      cfg: live,
      config: configMcp.connections,
      file: fileMcpConnections,
      obscura: getObscuraStatus()
    });
  };

  // Interactive OAuth for a config http oauth server (loopback opens the daemon-host browser; device
  // logs a code+URL), then force-reconnect it so the freshly-stored token takes effect — no restart.
  const mcpAuthorize = async (name: string): Promise<void> => {
    const live = (await loadAll(paths.config, paths.profile)) ?? cfg;
    const spec = live.mcpServers.find((s) => s.name === name);
    if (spec?.transport !== 'http') {
      throw new Error(`MCP server "${name}" is not an http server`);
    }
    await authorizeMcpOAuth({
      serverName: spec.name,
      serverUrl: spec.url,
      authPath: paths.auth,
      ...(spec.auth.mode === 'oauth'
        ? { clientId: spec.auth.clientId, scopes: spec.auth.scopes, flow: spec.auth.flow }
        : {}),
      log: (m) => logger.info(m)
    });
    const freshAuth = (await loadAuth(paths.auth)) ?? undefined;
    configMcp = {
      ...configMcp,
      connections: await reconnectOneMcpServer(name, configMcp.connections, live, paths, registry, freshAuth)
    };
  };

  // Manually (re)connect a single config server — retry a server that was down at boot, without a
  // restart or bouncing the others.
  const mcpReconnect = async (name: string): Promise<void> => {
    const live = (await loadAll(paths.config, paths.profile)) ?? cfg;
    const freshAuth = (await loadAuth(paths.auth)) ?? undefined;
    configMcp = {
      ...configMcp,
      connections: await reconnectOneMcpServer(name, configMcp.connections, live, paths, registry, freshAuth)
    };
  };

  const upgradeInfo = await createUpgradeInfoMonitor(paths);

  const handlers = createDaemonHandlers({
    store,
    agent,
    bus,
    cache,
    ownerPrincipalId,
    paths,
    memoryService,
    graphStore,
    getMem0Data,
    memorySetBackend,
    memorySetMem0Models,
    modelCatalog,
    modelService,
    kv,
    mockMode: USE_MOCK,
    oversight,
    delegation,
    hooks: hookRunner,
    hookCwd: sandboxRoots?.[0] ?? paths.workspace,
    sessionSandbox,
    agentToolFilter: (sid) => {
      const atoms = agentPersona.atomsFor(sid);
      return atoms ? (name) => isToolExposed(atoms, name, registry.sourceNameOf(name)) : undefined;
    },
    agentSandboxRoots: (sid) => agentPersona.sandboxRootsFor(sid),
    clarify,
    channelService,
    localeService: i18nService,
    configBus,
    commands: commandBundle,
    connectObscura,
    disconnectObscura,
    getObscuraStatus,
    getMcpStatus,
    mcpAuthorize,
    mcpReconnect,
    rediscoverAtomPacks: () => Promise.all([rediscoverAtomPacks(), reloadSkills()]).then(() => {}),
    getAtomConflicts: () => atomConflicts,
    reindexEmbeddings: () => {
      const cleared = store.clearEmbeddings();
      logger.info(`monad: cleared ${cleared} embedding(s) for re-index with the current embedding model`);
      embeddingIndexer.kick();
    },
    indexerStatus: () => embeddingIndexer.status(),
    skills: skillList,
    skillInstances,
    discoverProjectSkills,
    daemonWarnings,
    certFingerprint: tlsFingerprint,
    certExpiry: tlsCertExpiry,
    getUpgradeInfo: upgradeInfo.getUpgradeInfo,
    log: logger
  });

  sessionGateway = handlers.session;

  // Watch the atoms directory for drop-in installs: a new atom pack folder (or a removed one)
  // triggers the same rediscovery path as API-driven install/remove, so no daemon restart needed.
  reloadService.register({
    name: 'atoms',
    path: paths.atoms,
    recursive: true,
    // null = parent-dir rename event (macOS FSEvents coalescing). Any `.json` covers an atom-pack
    // manifest, a pack's mcp.json, a standalone atoms/mcp/*.json, and an enable/disable .install.json
    // edit — all of which the rediscovery sweep (re-scan packs + reconnect file MCP) must pick up.
    filter: (filename) => filename === null || filename.endsWith('.json'),
    onChange: () => {
      logger.info('monad: atoms directory changed — rediscovering atom packs');
      return Promise.all([rediscoverAtomPacks(), reloadSkills()]).then(() => {});
    }
  });

  runScheduled = async (prompt, sessionId) => {
    const sid =
      (sessionId as SessionId | undefined) ?? (await handlers.session.create({ title: 'Scheduled' })).sessionId;
    await handlers.session.generate({ sessionId: sid, text: prompt });
  };
  await schedule.load();
  process.on('exit', () => schedule.dispose());

  // Persist Mo's on/off toggle (web/cli start-stop) so the choice survives a daemon restart.
  const setMoEnabled = async (enabled: boolean): Promise<void> => {
    if (liveCfg.mo.enabled === enabled) return;
    liveCfg.mo.enabled = enabled;
    await saveProfile(paths.profile, liveCfg);
    await configBus.publish({ cfg: liveCfg, auth: liveAuth });
  };

  // Start listening (TCP + Unix socket, or stdio), print the ready banner, wire shutdown signals,
  // and connect channels (see ./bootstrap/serve.ts).
  await serveDaemon({
    handlers,
    paths,
    host: HOST,
    port: PORT,
    remoteAccess,
    moBinaryPath: liveCfg.mo.binaryPath,
    moEnabled: liveCfg.mo.enabled,
    setMoEnabled,
    tlsCert,
    tlsFingerprint,
    i18n: i18nService,
    channelService,
    flags: {
      devMode: DEV_MODE,
      devSilent: DEV_SILENT,
      stdoutRpc: STDOUT_RPC,
      stdioMode: STDIO_MODE,
      useMock: USE_MOCK
    },
    openaiCompatConfig: getOpenAiCompatConfig,
    beforeListen: opts?.beforeListen
  });
}

if (import.meta.main) {
  startDaemon().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
