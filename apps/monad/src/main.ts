/**
 * monad — a standalone full-agent runtime daemon.
 *
 * Copyright (c) 2026 Monadix Labs, Inc.
 * Released under the MIT License.
 * See LICENSE in the repository root for the full license text.
 *
 * Transports (clients choose the protocol):
 *   HTTP REST+SSE  https://127.0.0.1:52749           (control ops + event stream, TCP)
 *   HTTP REST+SSE  unix:~/.monad/run/monad.sock      (same Elysia app over a Unix socket — the
 *                                                      low-latency local path the CLI uses)
 *   WebSocket      wss://127.0.0.1:52749/v1/stream   (JSON-RPC framing, server-push, TCP only)
 *   stdio          stdin/stdout                      (NDJSON / JSON-RPC, --stdio only)
 *   ACP            stdin/stdout                      (Agent Client Protocol for editors, --acp;
 *                                                      bidirectional peer — see transports/acp/)
 */

import type { MonadAuth, MonadConfig } from '@monad/home';
import type { NetworkRuntimeStatus, PrincipalId, SessionId } from '@monad/protocol';
import type { ModelSubsystem } from '#/agent/model/lifecycle.ts';
import type { AtomDiscovery } from '#/atoms/lifecycle.ts';
import type { CapabilitiesRuntime } from '#/capabilities/lifecycle.ts';
import type { McpRuntime } from '#/capabilities/mcp/lifecycle.ts';
import type { SkillSubsystem } from '#/capabilities/skills/service.ts';
import type { Tool } from '#/capabilities/tools/types.ts';
import type { SessionGateway } from '#/channels/channel.ts';
import type { SandboxSetup } from '#/platform/sandbox/service.ts';
import type { DataLayer } from '#/store/lifecycle.ts';

import { join } from 'node:path';
import { getPaths, initMonadHome, loadAll, loadAuth, resolveDaemonNetwork } from '@monad/home';
import { createLogger } from '@monad/logger';

import { createInterruptServices } from '#/agent/approvals/interrupts.ts';
import { createConfigWatchers } from '#/agent/config.ts';
import { applyAcpDelegateTool } from '#/agent/delegation/acp-tool.ts';
import { createAgentExecutionService } from '#/agent/execution.ts';
import { createMemorySubsystem } from '#/agent/memory/subsystem.ts';
import { createAtomPackRediscoverer } from '#/atoms/reload.ts';
import { createMcpControls } from '#/capabilities/mcp/controls.ts';
import { createObscuraController } from '#/capabilities/mcp/obscura.ts';
import { buildServiceTools } from '#/capabilities/tools';
import { configureToolBackends } from '#/capabilities/tools/configure-backends.ts';
import { createChannelGateway } from '#/channels/gateway.ts';
import { createHotReload } from '#/config/application.ts';
import { createConfigReloader } from '#/config/reloader.ts';
import { createHomeConfigSource } from '#/config/source.ts';
import { createCommandBundle } from '#/handlers/commands/bundle.ts';
import { type CommandBundle } from '#/handlers/commands/index.ts';
import { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';
import { createHookRunner } from '#/hooks/runner.ts';
import { daemonChildProcesses, runDaemonChildSupervisorFromArgv } from '#/infra/daemon-child-processes.ts';
import { initObservability, resolveObservabilityEndpoint } from '#/infra/observability.ts';
import { ReloadService } from '#/reload/index.ts';
import { createDaemonModules, createDaemonRuntime } from '#/runtime/create.ts';
import { configureDaemonLogging, readDaemonRuntimeFlags } from '#/runtime/flags.ts';
import { acquireDaemonSingletonLock } from '#/runtime/singleton.ts';
import { DelegationService } from '#/services/delegation/delegation.ts';
import { createPeerDelegateTools } from '#/services/delegation/peers.ts';
import { acpAgentCandidatesFromAdapters } from '#/services/delegation/presets.ts';
import { configureDeveloperLogTransport } from '#/services/developer-log.ts';
import { EventBus } from '#/services/event-bus.ts';
import { isToolExposed } from '#/services/generation/agent-persona.ts';
import { createLocaleService } from '#/services/i18n-loader.ts';
import { createGraphQueryTools } from '#/services/memory/graph/query-tools.ts';
import { createMemoryAgentTools } from '#/services/memory/tools.ts';
import { RoundCache } from '#/services/round-cache.ts';
import { ScheduleService } from '#/services/scheduling/schedule.ts';
import { createUpgradeInfoMonitor } from '#/services/upgrade-info.ts';
import { warnIfNotInitialized } from '#/store/home/init-status.ts';
import {
  prependMonadBinToPath,
  seedDevProviderIfNeeded,
  startStartupHousekeeping
} from '#/store/home/startup-housekeeping.ts';
import { createDataLayer } from '#/store/lifecycle.ts';
import { runAcpBridge } from '#/transports/acp/launch.ts';
import { serveDaemon } from '#/transports/lifecycle.ts';
import { resolveTlsSetupForNetwork, type TlsSetup } from '#/transports/tls.ts';
import { createHttpTransport } from './transports/http.ts';

// Eden type-safe client inference (compile-time only). Derived from the transport factory
// so it stays valid without a module-level app instance.
// NOTE: this import intentionally uses a relative path so tsc emits a resolvable path in
// dist/main.d.ts — the @/ alias is internal to @monad/monad and would not resolve for
// consumers (e.g. @monad/client) reading the generated d.ts.
type HttpTransport = ReturnType<typeof createHttpTransport>;
export type App = HttpTransport;

configureDaemonLogging();
const logger = createLogger('monad-daemon');

export async function startDaemon(opts?: { beforeListen?: (app: App) => void }): Promise<void> {
  if (await runDaemonChildSupervisorFromArgv()) return;

  const paths = getPaths();

  // ACP mode is a thin BRIDGE: it discovers (or auto-spawns) a shared daemon and proxies the
  // editor's connection to it, so it must NOT take the singleton lock or build a daemon in-process
  // — that lock belongs to the daemon it bridges to. Branch out before daemon startup.
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
  // TODO: for local dev? tree shake it
  await seedDevProviderIfNeeded({
    paths,
    useMock: USE_MOCK,
    devMode: DEV_MODE,
    devSilent: DEV_SILENT,
    logger
  });

  const dataLayer = await createDataLayer({ paths, devMode: DEV_MODE || DEV_SILENT });
  const { kv, store } = dataLayer;
  const [cfg, startupAuthValue] = await Promise.all([loadAll(paths.config, paths.profile), loadAuth(paths.auth)]);
  if (!cfg) throw new Error('monad: config.json missing after repair — aborting');
  const startupAuth = startupAuthValue ?? undefined;
  configureDeveloperLogTransport(paths, cfg.developerMode === true);
  const ownerPrincipalId = cfg.principal.id as PrincipalId;

  const monadVersion = await Bun.file(join(import.meta.dir, '..', 'package.json'))
    .json()
    .then((value: { version?: string }) => value.version ?? '0.0.0')
    .catch(() => '0.0.0');
  const reloadService = new ReloadService({ log: (level, message) => logger[level](message) });
  process.on('exit', () => reloadService.closeAll());
  let runtime: ReturnType<typeof createDaemonRuntime>;
  let applyApplicationConfig = async (_snapshot: { cfg: MonadConfig; auth: MonadAuth | null }): Promise<void> => {};
  let applyNetworkConfig = async (_snapshot: { cfg: MonadConfig; auth: MonadAuth | null }): Promise<void> => {};
  const configReloader = createConfigReloader(async () => {
    await runtime.config.refreshNow();
  });
  const configSource = createHomeConfigSource(paths, {
    watch: (onChange) => {
      reloadService.register({
        name: 'settings',
        path: paths.home,
        filter: (filename) =>
          filename === 'config.json' ||
          filename === 'profile.json' ||
          filename === 'sandbox.json' ||
          filename === 'auth.json',
        onChange
      });
      return () => {};
    }
  });
  const initial = { cfg, auth: startupAuthValue };
  runtime = createDaemonRuntime({
    initial,
    modules: createDaemonModules({
      initial,
      paths,
      devMode: DEV_MODE || DEV_SILENT,
      useMock: USE_MOCK,
      monadVersion,
      watcher: reloadService,
      logger,
      startStore: async () => dataLayer
    }),
    source: configSource,
    watchOnStart: false,
    afterReload: async (snapshot) => {
      await applyApplicationConfig(snapshot);
      await applyNetworkConfig(snapshot);
    }
  });
  await runtime.start();

  const runtimeData = runtime.kernel.context.get<DataLayer>('store');
  const sandbox = runtime.kernel.context.get<SandboxSetup>('platform.sandbox');
  const model = runtime.kernel.context.get<ModelSubsystem>('agent.model');
  const capabilities = runtime.kernel.context.get<CapabilitiesRuntime>('capabilities');
  const atoms = runtime.kernel.context.get<AtomDiscovery>('atoms');
  const skills = runtime.kernel.context.get<SkillSubsystem>('capabilities.skills');
  const mcpRuntime = runtime.kernel.context.get<McpRuntime>('capabilities.mcp');
  const { sandboxRoots, sessionSandbox } = sandbox;
  const { modelService, modelCatalog, embeddingIndexer } = model;
  const { registry, commandRegistry } = capabilities;
  const { loadedSkills, skillList, skillInstances, discoverProjectSkills, reloadSkills } = skills;
  const {
    channelRegistry,
    atomConflicts,
    atomDetailsByPack,
    refreshWorkspaceExperienceSnapshot,
    getWorkspaceExperienceSnapshot
  } = atoms;
  if (runtimeData !== dataLayer) throw new Error('monad: runtime store output mismatch');

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
  // Resolve the daemon's bind endpoint once from config + env. Clients use the same resolver so
  // host/port/protocol overrides stay in sync across daemon, web, CLI, and managed runtimes.
  const endpoint = resolveDaemonNetwork({ network: cfg.network, env: Bun.env });
  const PORT = endpoint.port;
  const HOST = endpoint.bindHost;

  await configureToolBackends(cfg, startupAuth);

  const bus = new EventBus();
  const cache = new RoundCache();
  const { oversight, clarify, reloadApprovalPolicy } = await createInterruptServices({ paths, cfg, store, bus });
  startStartupHousekeeping({ paths, store, logger });
  // Reverse fs/terminal delegation for ACP-bridged sessions. Unlike oversight/clarify, its events are
  // ephemeral RPC — bus-only, NEVER persisted (replaying a delegation request on reconnect is wrong).
  const delegation = new DelegationService({ publish: (event) => bus.publish(event) });
  if (!USE_MOCK) {
    warnIfNotInitialized({ cfg, auth: startupAuth, host: HOST, port: PORT, logger });
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
  // config/profile/auth file watcher (feeding the shared ConfigReloader), workspace prompt slots, and
  // per-agent persona resolution (see #/agent/config.ts).
  const {
    getHooksConfig,
    setHooksConfig,
    getPolicyHooksConfig,
    setPolicyHooksConfig,
    getWorkspacePromptSlots,
    agentPersona
  } = await createConfigWatchers({
    paths,
    cfg,
    store,
    reloadService,
    logger,
    configReloader,
    watchSettings: false
  });

  const activeDeveloperMode = cfg.developerMode === true || DEV_MODE || DEV_SILENT;
  const otelEndpoint = resolveObservabilityEndpoint({
    endpoint: cfg.observability?.endpoint,
    developerMode: activeDeveloperMode
  });
  const otelActive = initObservability(otelEndpoint, monadVersion);
  if (otelActive && !cfg.observability?.endpoint) {
    logger.info('monad: OTel auto-enabled for dev — Phoenix UI at http://localhost:6006');
  }

  const agentModel = USE_MOCK ? (await import('#/infra/mock-model.ts')).mockModel() : modelService.router;
  let sessionGateway: SessionGateway | null = null;

  // Locale gateway: file-scan loading from the builtin locale dir + any installed atom-pack locale
  // dirs (see #/services/i18n-loader.ts).
  const i18nService = await createLocaleService(paths, cfg.locale);

  const reconnectFileMcp = () => mcpRuntime.reconnectFiles(runtime.config.get().auth);

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

  // Memory subsystem: auto-memory note store, layered L1 memory service (mem0 + daemon-managed local
  // qdrant), L2 knowledge graph + background consolidation, the read-only mem0 explorer, and memory
  // settings write-back, with the lifecycle hooks registered (see #/agent/memory/subsystem.ts).
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
    configReloader,
    liveCfg: () => runtime.config.get().cfg,
    liveAuth: () => runtime.config.get().auth
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
  // configReloader publish below. Mounted only when ≥1 agent is enabled (an empty roster advertises nothing).
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
  // #/agent/execution.ts). Schedule/memory/acp-delegate tools are wired here and passed in.
  const { agent, history } = createAgentExecutionService({
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
    // Live so a profile.json/settings edit to the policy hot-applies (updated by the configReloader subscriber).
    inboundApproval: () => inboundApprovalMode,
    workspacePromptSlots: (sessionId) => ({
      ...getWorkspacePromptSlots(),
      agent: agentPersona.resolve(sessionId) ?? getWorkspacePromptSlots().agent
    })
  });

  // Backend for the unified slash commands — model list/switch, /compact, /handoff, memory + graph
  // consolidation, and the highRisk approval gate (see #/handlers/commands/bundle.ts). sessionGateway is
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

  applyApplicationConfig = createHotReload({
    paths,
    store,
    agentPersona,
    embeddingIndexer,
    channelService,
    registry,
    i18nService,
    logger,
    gate: oversight.gate,
    reloadApprovalPolicy,
    setInboundApprovalMode: (mode) => {
      inboundApprovalMode = mode;
    },
    setHooksConfig,
    setPolicyHooksConfig
  });

  // Auto-generated self-signed TLS for the primary HTTPS listener (see #/transports/tls.ts).
  let tlsSetup: TlsSetup = await resolveTlsSetupForNetwork({ https: cfg.network.https, tlsDir: paths.tls });
  const resolveRuntimeTlsSetup = async (https: MonadConfig['network']['https']): Promise<TlsSetup> => {
    tlsSetup = await resolveTlsSetupForNetwork({ https, tlsDir: paths.tls, current: tlsSetup });
    return tlsSetup;
  };

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
  // hash + per-tool auto-approve), one live connection (see #/capabilities/mcp/obscura.ts).
  const { connectObscura, disconnectObscura, getObscuraStatus } = createObscuraController({ registry, log: logger });

  const { getMcpStatus, mcpAuthorize, mcpReconnect } = createMcpControls({
    paths,
    cfg,
    registry,
    logger,
    getConfigMcp: () => mcpRuntime.config,
    setConfigMcp: (v) => {
      mcpRuntime.replaceConfig(v);
    },
    fileMcpConnections: () => [...mcpRuntime.files],
    obscuraStatus: () => getObscuraStatus()
  });

  const upgradeInfo = await createUpgradeInfoMonitor(paths);

  let getNetworkRuntimeStatus: (() => NetworkRuntimeStatus | undefined) | undefined;
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
    configReloader,
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
    getDaemonWarnings: () => tlsSetup.warnings,
    getNetworkRuntimeStatus: () => getNetworkRuntimeStatus?.(),
    getCertFingerprint: () => tlsSetup.fingerprint,
    getCertExpiry: () => tlsSetup.expiry,
    networkHttps: cfg.network.https,
    externalAgentServerUrl: endpoint.localUrl,
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
    if (runtime.config.get().cfg.mo.enabled === enabled) return;
    await runtime.config.updateConfig((current) => ({ ...current, mo: { ...current.mo, enabled } }));
  };

  const serveCfg = runtime.config.get().cfg;

  // Start listening (TCP + Unix socket, or stdio), print the ready banner, wire shutdown signals,
  // and connect channels (see #/transports/lifecycle.ts).
  await serveDaemon({
    handlers,
    paths,
    host: HOST,
    port: PORT,
    https: serveCfg.network.https,
    remoteAccess,
    localHttpFallback: {
      enabled: serveCfg.network.localHttpFallback.enabled,
      port:
        resolveDaemonNetwork({ network: serveCfg.network, env: Bun.env }).localHttpFallback?.port ??
        serveCfg.network.localHttpFallback.port
    },
    moBinaryPath: serveCfg.mo.binaryPath,
    moEnabled: serveCfg.mo.enabled,
    setMoEnabled,
    tlsCert: tlsSetup.cert,
    tlsFingerprint: tlsSetup.fingerprint,
    resolveTlsSetupForNetwork: resolveRuntimeTlsSetup,
    developerMode: () => runtime.config.get().cfg.developerMode === true,
    i18n: i18nService,
    channelService,
    onNetworkReloadReady: (reload) => {
      applyNetworkConfig = reload;
    },
    onNetworkRuntimeStatusReady: (status) => {
      getNetworkRuntimeStatus = status;
    },
    flags: {
      devMode: DEV_MODE,
      devSilent: DEV_SILENT,
      stdoutRpc: STDOUT_RPC,
      stdioMode: STDIO_MODE,
      useMock: USE_MOCK
    },
    openaiCompatConfig: getOpenAiCompatConfig,
    onShutdown: async () => {
      schedule.dispose();
      reloadService.closeAll();
      await channelService.stop();
      await runtime.stop();
    },
    beforeListen: opts?.beforeListen
  });
  runtime.startWatching();
}

if (import.meta.main) {
  startDaemon().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
