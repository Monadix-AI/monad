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
import type { PrincipalId, SessionId } from '@monad/protocol';
import type { Tool } from '@/capabilities/tools/types.ts';
import type { SessionGateway } from '@/channels/channel.ts';

import { join } from 'node:path';
import { getPaths, initMonadHome, loadAll, loadAuth, saveProfile } from '@monad/home';
import { createLogger } from '@monad/logger';

import { applyAcpDelegateTool } from '@/bootstrap/acp-delegate.ts';
import { buildServiceTools, builtinTools } from '@/capabilities/tools';
import { AtomPackRegistry } from '@/handlers/atom-pack/index.ts';
import { type CommandBundle, createCommandRegistry } from '@/handlers/commands/index.ts';
import { createDaemonHandlers } from '@/handlers/handlers.ts';
import { createHookRunner } from '@/hooks/runner.ts';
import { daemonChildProcesses, runDaemonChildSupervisorFromArgv } from '@/infra/daemon-child-processes.ts';
import { initObservability } from '@/infra/observability.ts';
import { ReloadService } from '@/reload/index.ts';
import { DelegationService } from '@/services/delegation/delegation.ts';
import { acpAgentCandidatesFromAdapters } from '@/services/delegation/presets.ts';
import { configureDeveloperLogTransport } from '@/services/developer-log.ts';
import { EventBus } from '@/services/event-bus.ts';
import { isToolExposed } from '@/services/generation/agent-persona.ts';
import { createGraphQueryTools } from '@/services/memory/graph/query-tools.ts';
import { createMemoryAgentTools } from '@/services/memory/tools.ts';
import { RoundCache } from '@/services/round-cache.ts';
import { ScheduleService } from '@/services/scheduling/schedule.ts';
import { runAcpBridge } from '@/transports/acp/launch.ts';
import { createDaemonAgent } from './bootstrap/agent.ts';
import { createAtomPackRediscoverer } from './bootstrap/atoms.ts';
import { createChannelGateway } from './bootstrap/channel-gateway.ts';
import { createCommandBundle } from './bootstrap/commands.ts';
import { createDataLayer } from './bootstrap/data-layer.ts';
import { registerHotReload } from './bootstrap/hot-reload.ts';
import { createInterruptServices } from './bootstrap/interrupts.ts';
import { createAtomDiscovery } from './bootstrap/main-init/atom-discovery.ts';
import { createConfigWatchers } from './bootstrap/main-init/config-watchers.ts';
import { warnIfNotInitialized } from './bootstrap/main-init/init-status.ts';
import { createLocaleService } from './bootstrap/main-init/locale.ts';
import { connectFileMcpServers, connectMcpServers } from './bootstrap/mcp.ts';
import { createMcpControls } from './bootstrap/mcp-controls.ts';
import { createMemorySubsystem } from './bootstrap/memory.ts';
import { createModelSubsystem } from './bootstrap/model.ts';
import { createObscuraController } from './bootstrap/obscura.ts';
import { createPeerDelegateTools } from './bootstrap/peers.ts';
import { configureDaemonLogging, readDaemonRuntimeFlags } from './bootstrap/runtime-flags.ts';
import { createSandbox } from './bootstrap/sandbox.ts';
import { serveDaemon } from './bootstrap/serve.ts';
import { acquireDaemonSingletonLock } from './bootstrap/singleton.ts';
import { createSkillSubsystem } from './bootstrap/skills.ts';
import {
  prependMonadBinToPath,
  seedDevProviderIfNeeded,
  startStartupHousekeeping
} from './bootstrap/startup-housekeeping.ts';
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
  if (await runDaemonChildSupervisorFromArgv()) return;

  const paths = getPaths();

  // ACP mode is a thin BRIDGE: it discovers (or auto-spawns) a shared daemon and proxies the
  // editor's connection to it, so it must NOT take the singleton lock or build a daemon in-process
  // — that lock belongs to the daemon it bridges to. Branch out before any daemon bootstrap.
  if (process.argv.includes('--acp')) {
    await runAcpBridge(paths);
    return;
  }

  await acquireDaemonSingletonLock(paths);

  const {
    stdioMode: STDIO_MODE,
    stdoutRpc: STDOUT_RPC,
    useMock: USE_MOCK,
    devMode: DEV_MODE,
    devSilent: DEV_SILENT
  } = readDaemonRuntimeFlags();

  await initMonadHome(paths);
  daemonChildProcesses.configure(join(paths.runtime, 'daemon-child-processes.json'), {
    supervisorEntryPath: import.meta.path
  });

  prependMonadBinToPath(paths);
  await seedDevProviderIfNeeded({
    paths,
    useMock: USE_MOCK,
    devMode: DEV_MODE,
    devSilent: DEV_SILENT,
    logger
  });

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
  // assigned by scripts/dev-init.ts). Clients honour the same var in resolveClientConn so they
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
  const cache = new RoundCache();
  const { oversight, clarify, reloadApprovalPolicy } = await createInterruptServices({ paths, cfg, store, bus });
  startStartupHousekeeping({ paths, store, logger });
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
    warnIfNotInitialized({ cfg, auth: startupAuth, host: HOST, port: PORT, logger });
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

  // Live config-derived state: skill auto-load predicate, hot-swappable command/policy hooks, the
  // config/profile/auth file watcher (feeding the shared ConfigBus), workspace prompt slots, and
  // per-agent persona resolution (see ./bootstrap/main-init/config-watchers.ts).
  const {
    configBus,
    computeSkillState,
    getSkillState,
    setSkillState,
    getHooksConfig,
    setHooksConfig,
    getPolicyHooksConfig,
    setPolicyHooksConfig,
    getWorkspacePromptSlots,
    agentPersona
  } = await createConfigWatchers({ paths, cfg, store, reloadService, logger });

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
    skillState: (skill) => getSkillState()(skill)
  });

  const agentModel = USE_MOCK ? (await import('@/infra/mock-model.ts')).mockModel() : modelService.router;

  // Discover atom packs (built-in + ~/.monad/atoms) through the atom-kind-gated loader BEFORE the
  // agent snapshots its tools below — so a third-party atom pack's declared tools/connectors reach
  // the agent. Channel factories are collected for the channel gateway (constructed later). An atom
  // pack that registers an undeclared atom kind is rejected here (UndeclaredAtomError), per pack
  // (see ./bootstrap/main-init/atom-discovery.ts).
  let sessionGateway: SessionGateway | null = null;
  const {
    channelRegistry,
    atomConflicts,
    atomDetailsByPack,
    refreshWorkspaceExperienceSnapshot,
    getWorkspaceExperienceSnapshot
  } = await createAtomDiscovery({ paths, cfg, registry, commandRegistry, modelService, logger });

  // Locale gateway: file-scan loading from the builtin locale dir + any installed atom-pack locale
  // dirs (see ./bootstrap/main-init/locale.ts).
  const i18nService = await createLocaleService(paths, cfg.locale);

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
    runConsolidate,
    runCheckContradictions,
    explainBelief,
    getMem0Data,
    getLaws,
    memorySetBackend,
    memorySetMem0Models,
    memorySetGraph
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
    config: () => getHooksConfig(),
    policy: () => getPolicyHooksConfig(),
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
    adapterCandidates: acpAgentCandidatesFromAdapters(),
    gate: oversight.gate,
    mcpServers: cfg.mcpServers,
    auth: startupAuth,
    store
  });

  const peerDelegateTools = createPeerDelegateTools({
    peers: cfg.peers,
    auth: startupAuth,
    gate: oversight.gate,
    logger
  });

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
      ...getWorkspacePromptSlots(),
      agent: agentPersona.resolve(sessionId) ?? getWorkspacePromptSlots().agent
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
    runConsolidate,
    runCheckContradictions,
    explainBelief,
    oversight,
    i18n: i18nService,
    bus,
    sessionGateway: () => sessionGateway,
    logger
  });

  const channelService = await createChannelGateway({
    sessionGateway: () => sessionGateway,
    store,
    registry: channelRegistry,
    bus,
    i18n: i18nService,
    commands: commandBundle,
    logger,
    cfg,
    paths
  });

  registerHotReload({
    configBus,
    paths,
    store,
    modelService,
    agentPersona,
    embeddingIndexer,
    channelService,
    registry,
    i18nService,
    logger,
    gate: oversight.gate,
    computeSkillState,
    reloadSkills,
    reloadApprovalPolicy,
    setInboundApprovalMode: (mode) => {
      inboundApprovalMode = mode;
    },
    setSkillState,
    setHooksConfig,
    setPolicyHooksConfig,
    getConfigMcp: () => configMcp,
    setConfigMcp: (v) => {
      configMcp = v;
    },
    setConfigMcpHttp: (v) => {
      configMcpHttp = v;
    }
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
    atomDetailsByPack,
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

  const { getMcpStatus, mcpAuthorize, mcpReconnect } = createMcpControls({
    paths,
    cfg,
    registry,
    logger,
    getConfigMcp: () => configMcp,
    setConfigMcp: (v) => {
      configMcp = v;
    },
    fileMcpConnections: () => fileMcpConnections,
    obscuraStatus: () => getObscuraStatus()
  });

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
    getLaws,
    memorySetBackend,
    memorySetMem0Models,
    memorySetGraph,
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
    rediscoverAtomPacks: async () => {
      await Promise.all([rediscoverAtomPacks(), reloadSkills()]);
      await refreshWorkspaceExperienceSnapshot();
    },
    getAtomConflicts: () => atomConflicts,
    getAtomDetails: (packName: string) => atomDetailsByPack.get(packName),
    getWorkspaceExperienceSnapshot,
    getWorkspaceExperienceApiHandler: (experienceId, method, path) =>
      registry.getWorkspaceExperienceApiHandler(experienceId, method, path),
    getWorkspaceExperiences: () => [...registry.workspaceExperiences.values()],
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
    nativeCliServerUrl: `http://127.0.0.1:${PORT}`,
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
