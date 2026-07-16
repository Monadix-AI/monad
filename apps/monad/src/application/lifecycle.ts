import type { SessionId } from '@monad/protocol';

import { createLogger } from '@monad/logger';
import { newId } from '@monad/protocol';

import { createAgentRuntime } from '#/application/agent-runtime.ts';
import { createCoreRuntime } from '#/application/core-runtime.ts';
import { createNetworkRuntime } from '#/application/network-runtime.ts';
import { runDaemonPreflight } from '#/application/preflight.ts';
import { launchDaemonTransports } from '#/application/transport-runtime.ts';
import { createAtomPackRediscoverer } from '#/atoms/reload.ts';
import { createMcpControls } from '#/capabilities/mcp/controls.ts';
import { createObscuraController } from '#/capabilities/mcp/obscura.ts';
import { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';
import { configureDaemonLogging } from '#/runtime/flags.ts';
import { makeEvent } from '#/services/event-bus.ts';
import { isToolExposed } from '#/services/generation/agent-persona.ts';
import { createMonadixProviderManager } from '#/services/monadix/index.ts';
import { createMonadixTaskRunner } from '#/services/monadix/task-runner.ts';
import { createUpgradeInfoMonitor } from '#/services/upgrade-info.ts';
import { createHttpTransport } from '#/transports/http.ts';

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
  const preflight = await runDaemonPreflight({ supervisorEntryPath: import.meta.path, logger });
  if (!preflight) return;
  const { paths, flags } = preflight;
  const {
    stdioMode: STDIO_MODE,
    stdoutRpc: STDOUT_RPC,
    useMock: USE_MOCK,
    devMode: DEV_MODE,
    devSilent: DEV_SILENT
  } = flags;
  const core = await createCoreRuntime(preflight, logger);
  const {
    dataLayer,
    cfg,
    watchService,
    runtime,
    reloadTargets,
    sandbox,
    model,
    capabilities,
    atoms,
    skills,
    mcp: mcpRuntime,
    interactions
  } = core;
  const { kv, store } = dataLayer;
  const { sandboxRoots, sessionSandbox } = sandbox;
  const { modelService, modelCatalog, embeddingIndexer } = model;
  const { registry, commandRegistry } = capabilities;
  const { skillList, skillInstances, discoverProjectSkills, reloadSkills } = skills;
  const { atomConflicts, atomDetailsByPack, refreshWorkspaceExperienceSnapshot, getWorkspaceExperienceSnapshot } =
    atoms;

  const networkRuntime = await createNetworkRuntime({
    network: cfg.network,
    initialOpenAiCompat: cfg.openaiCompat,
    paths,
    env: Bun.env,
    loadConfig: async () => runtime.config.get().cfg
  });
  const { endpoint, remoteAccess } = networkRuntime;
  const PORT = endpoint.port;
  const HOST = endpoint.bindHost;

  const agentRuntime = await createAgentRuntime(core, { host: HOST, port: PORT }, logger);
  const {
    bus,
    cache,
    oversight,
    clarify,
    delegation,
    agentPersona,
    i18nService,
    schedule,
    memory,
    hookRunner,
    agent,
    commandBundle,
    channelService,
    bindSessionGateway,
    bindScheduledRun,
    reconnectFileMcp,
    setMonadixSync
  } = agentRuntime;
  const { memoryService, graphStore, getMem0Data, getLaws, memorySetBackend, memorySetMem0Models, memorySetGraph } =
    memory;

  const rediscoverAtomPacks = createAtomPackRediscoverer({
    paths,
    config: runtime.config,
    atomConflicts,
    atomDetailsByPack,
    commandRegistry,
    toolRegistry: registry,
    modelProviderRegistry: modelService.registry,
    i18nService,
    reconnectFileMcp,
    channelService,
    interactions
  });

  // Optional Obscura stdio MCP server: connect/disconnect/status behind a trust gate (pinned tool-set
  // hash + per-tool auto-approve), one live connection (see #/capabilities/mcp/obscura.ts).
  const { connectObscura, disconnectObscura, getObscuraStatus } = createObscuraController({ registry, log: logger });

  const { getMcpStatus, mcpAuthorize, mcpReconnect } = createMcpControls({
    paths,
    registry,
    logger,
    config: runtime.config,
    getConfigMcp: () => mcpRuntime.config,
    setConfigMcp: (v) => {
      mcpRuntime.replaceConfig(v);
    },
    fileMcpConnections: () => [...mcpRuntime.files],
    obscuraStatus: () => getObscuraStatus()
  });
  const disposeMcpStatusStream = mcpRuntime.onStatusChange(() => {
    bus.publish(makeEvent(newId('ses'), 'mcp.status_updated', {}));
  });
  process.on('exit', disposeMcpStatusStream);

  const upgradeInfo = await createUpgradeInfoMonitor(paths);

  const handlers = createDaemonHandlers({
    store,
    agent,
    bus,
    cache,
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
      const consumesMonadix = agentPersona.monadixConsumesFor(sid);
      // Monadix consumer tools are a per-agent opt-in (monadix.consume), independent of the atoms
      // allow/deny filter. Everything else follows the agent's atoms policy (or is unrestricted).
      return (name) => {
        if (name.startsWith('monadix__')) return consumesMonadix;
        return atoms ? isToolExposed(atoms, name, registry.sourceNameOf(name)) : true;
      };
    },
    agentSandboxRoots: (sid) => agentPersona.sandboxRootsFor(sid),
    clarify,
    channelService,
    localeService: i18nService,
    configManager: runtime.config,
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
    getWorkspaceExperienceApiRoute: (experienceId, method, path) =>
      registry.getWorkspaceExperienceApiRoute(experienceId, method, path),
    getExperienceWorkers: () => [...registry.experienceWorkers.values()],
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
    getDaemonWarnings: () => networkRuntime.tls().warnings,
    getNetworkRuntimeStatus: networkRuntime.status,
    getCertFingerprint: () => networkRuntime.tls().fingerprint,
    getCertExpiry: () => networkRuntime.tls().expiry,
    networkHttps: cfg.network.https,
    externalAgentServerUrl: endpoint.localUrl,
    getUpgradeInfo: upgradeInfo.getUpgradeInfo,
    log: logger
  });

  bindSessionGateway(handlers.session);

  // Watch the atoms directory for drop-in installs: a new atom pack folder (or a removed one)
  // triggers the same rediscovery path as API-driven install/remove, so no daemon restart needed.
  watchService.register({
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

  bindScheduledRun(async (prompt, sessionId) => {
    const sid =
      (sessionId as SessionId | undefined) ?? (await handlers.session.create({ title: 'Scheduled' })).sessionId;
    await handlers.session.generate({ sessionId: sid, text: prompt });
  });
  await schedule.load();
  process.on('exit', () => schedule.dispose());

  const serveCfg = runtime.config.get().cfg;
  await launchDaemonTransports({
    serveOptions: {
      handlers,
      paths,
      host: HOST,
      port: PORT,
      https: serveCfg.network.https,
      remoteAccess,
      localHttpFallback: {
        enabled: serveCfg.network.localHttpFallback.enabled,
        port: endpoint.localHttpFallback?.port ?? serveCfg.network.localHttpFallback.port
      },
      moBinaryPath: serveCfg.mo.binaryPath,
      moEnabled: serveCfg.mo.enabled,
      developerMode: () => runtime.config.get().cfg.developerMode === true,
      i18n: i18nService,
      channelService,
      interactions,
      flags: {
        devMode: DEV_MODE,
        devSilent: DEV_SILENT,
        stdoutRpc: STDOUT_RPC,
        stdioMode: STDIO_MODE,
        useMock: USE_MOCK
      },
      beforeListen: opts?.beforeListen
    },
    runtime,
    network: networkRuntime,
    reloadTargets,
    schedule,
    watchers: watchService,
    channels: channelService
  });

  // Monadix provider presence: one registration + realtime subscription PER public agent
  // (`visibility.public`), dial-out over Supabase Realtime (no public URL). The manager reconciles
  // the live set on boot and on every config reload (so a toggle applies without a restart). Runs
  // after transports are listening so a served agent can answer inbound tasks immediately.
  const setAgentPublished = async (
    agentId: string,
    published: { providerId: string; publishedAt: string } | undefined
  ) => {
    await runtime.config.updateConfig((live) => {
      const target = live.agent.agents.find((a) => a.id === agentId);
      if (target) target.published = published;
    });
  };
  const monadixManager = createMonadixProviderManager({
    getConfig: () => runtime.config.get().cfg.monadix,
    getToken: async () => runtime.config.get().auth?.mcpOAuth?.monadix?.accessToken,
    runnerFor: (agentId) => createMonadixTaskRunner({ handlers, agentId, logger }),
    persistProviderId: (agentId, providerId) =>
      setAgentPublished(agentId, { providerId, publishedAt: new Date().toISOString() }),
    clearProviderId: (agentId) => setAgentPublished(agentId, undefined),
    logger
  });
  const monadixAgentsFrom = (c: typeof cfg) =>
    c.agent.agents.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      isPublic: a.visibility?.public === true,
      providerId: a.published?.providerId
    }));
  setMonadixSync((freshCfg) => monadixManager.sync(monadixAgentsFrom(freshCfg)));
  // Fire-and-forget: registration + realtime connect are external network I/O and must stay off the
  // cold-start path (they run after listen anyway). Failures are logged inside the manager. Shutdown
  // teardown is intentionally not wired to `process.on('exit')` — it can't await the async
  // deregister/removeChannel; the daemon's presence heartbeat simply stops and cabinet's stale-provider
  // cron reaps it. Live config-reload teardown (unpublish) still runs through the awaited sync path.
  void monadixManager.sync(monadixAgentsFrom(runtime.config.get().cfg));
}
