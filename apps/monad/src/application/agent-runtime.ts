export interface RuntimeBinding<T> {
  read(): T;
  bind(value: T): void;
}

export function createRuntimeBinding<T>(initial: T): RuntimeBinding<T> {
  let current = initial;
  return {
    read: () => current,
    bind(value) {
      current = value;
    }
  };
}

export async function createAgentRuntime(core: DaemonCore, endpoint: { host: string; port: number }, logger: Logger) {
  const { paths, flags, cfg, startupAuth, monadVersion, watchService, runtime, reloadTargets } = core;
  const { store } = core.dataLayer;
  const { sandboxRoots } = core.sandbox;
  const { modelService, modelCatalog, embeddingIndexer } = core.model;
  modelService.setAuthPersistence(async (auth) => {
    await runtime.config.updateAuth(() => auth);
  });
  const { registry, commandRegistry } = core.capabilities;
  const { loadedSkills, skillList } = core.skills;

  await configureToolBackends(cfg, startupAuth);
  const bus = new EventBus();
  const cache = new RoundCache();
  const { oversight, clarify, reloadApprovalPolicy } = await createInterruptServices({ paths, cfg, store, bus });
  startStartupHousekeeping({ paths, store, logger });
  const delegation = new DelegationService({ publish: (event) => bus.publish(event) });
  if (!flags.useMock) {
    warnIfNotInitialized({ cfg, auth: startupAuth, host: endpoint.host, port: endpoint.port, logger });
  }

  const {
    getHooksConfig,
    setHooksConfig,
    getPolicyHooksConfig,
    setPolicyHooksConfig,
    getWorkspacePromptSlots,
    agentPersona
  } = await createConfigWatchers({ paths, cfg, store, watchService, logger });

  const developerMode = cfg.developerMode === true || flags.devMode || flags.devSilent;
  const otelEndpoint = resolveObservabilityEndpoint({ endpoint: cfg.observability?.endpoint, developerMode });
  const otelActive = initObservability(otelEndpoint, monadVersion);
  if (otelActive && !cfg.observability?.endpoint) {
    logger.info('monad: OTel auto-enabled for dev — Phoenix UI at http://localhost:6006');
  }

  const agentModel = flags.useMock ? (await import('#/infra/mock-model.ts')).mockModel() : modelService.router;
  const i18nService = await createLocaleService(paths, cfg.locale);
  const session = createRuntimeBinding<SessionGateway | null>(null);
  const scheduledRun = createRuntimeBinding<(prompt: string, sessionId: string | undefined) => Promise<void>>(
    async () => {}
  );
  const schedule = new ScheduleService({
    storePath: join(paths.runtime, 'schedules.json'),
    fire: (prompt, sessionId) => scheduledRun.read()(prompt, sessionId),
    log: (message) => logger.info(message)
  });

  const memory = createMemorySubsystem({
    store,
    paths,
    port: endpoint.port,
    router: agentModel,
    registry,
    config: runtime.config,
    liveCfg: () => runtime.config.get().cfg,
    liveAuth: () => runtime.config.get().auth
  });

  const hooksLog = createLogger('hooks');
  const hookRunner = createHookRunner({
    config: getHooksConfig,
    policy: getPolicyHooksConfig,
    atomHooks: registry.hooks,
    cwd: sandboxRoots?.[0] ?? paths.workspace,
    log: hooksLog,
    record: (event) => {
      const level =
        event.outcome === 'deny' || event.outcome === 'ask' || event.outcome === 'timeout' ? 'info' : 'debug';
      hooksLog[level](
        {
          event: event.event,
          source: event.source,
          label: event.label.slice(0, 200),
          outcome: event.outcome,
          durationMs: event.durationMs,
          reason: event.reason
        },
        'hook ran'
      );
    }
  });

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
  let inboundApprovalMode = cfg.openaiCompat.approval;
  // Set by lifecycle once the Monadix provider manager exists (it needs the daemon handlers). The
  // hot-reload subscriber calls it on every config change so a `visibility.public` toggle applies live.
  let monadixSync: ((cfg: MonadConfig) => Promise<void>) | undefined;
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
    baseTools: (): Tool[] => registry.toolList(),
    toolsVersion: () => registry.toolRevision,
    bus,
    memoryService: memory.memoryService,
    extraTools: [
      ...buildServiceTools({
        notes: memory.noteStore,
        scheduler: schedule,
        // Nothing is ever spilled to tool_raw_outputs when persistRaw is off, so read_tool_output
        // would always report "not found" — omit the tool entirely rather than advertise a dead one.
        ...(cfg.context.toolOutput.persistRaw
          ? { rawOutputs: { get: (sessionId, toolCallId) => store.getToolRawOutput(sessionId, toolCallId) } }
          : {})
      }),
      ...createMemoryAgentTools(memory.memoryService),
      ...createGraphQueryTools(memory.graphStore, memory.graphScopesFor),
      ...peerDelegateTools
    ],
    delegatableAgents: () => agentPersona.delegatableAgents(),
    toolSourceName: (name) => registry.sourceNameOf(name),
    hookRunner,
    inboundApproval: () => inboundApprovalMode,
    workspacePromptSlots: (sessionId) => ({
      ...getWorkspacePromptSlots(),
      agent: agentPersona.resolve(sessionId) ?? getWorkspacePromptSlots().agent
    })
  });

  const commandBundle = createCommandBundle({
    commandRegistry,
    skills: () => skillList,
    store,
    cfg,
    modelService,
    modelCatalog,
    agentModel,
    history,
    runConsolidate: memory.runConsolidate,
    runCheckContradictions: memory.runCheckContradictions,
    explainBelief: memory.explainBelief,
    oversight,
    i18n: i18nService,
    bus,
    sessionGateway: session.read,
    logger
  });
  const channelService = await createChannelGateway({
    sessionGateway: session.read,
    store,
    registry: core.atoms.channelRegistry,
    bus,
    i18n: i18nService,
    commands: commandBundle,
    logger,
    cfg,
    config: core.runtime.config
  });

  reloadTargets.setApplication(
    createHotReload({
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
      setPolicyHooksConfig,
      runMonadixSync: (freshCfg) => monadixSync?.(freshCfg) ?? Promise.resolve()
    })
  );

  return {
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
    bindSessionGateway: session.bind,
    bindScheduledRun: scheduledRun.bind,
    reconnectFileMcp: () => core.mcp.reconnectFiles(runtime.config.get().auth),
    setMonadixSync: (fn: (cfg: MonadConfig) => Promise<void>) => {
      monadixSync = fn;
    }
  };
}

import type { MonadConfig } from '@monad/environment';
import type { Logger } from '@monad/logger';
import type { DaemonCore } from '#/application/core-runtime.ts';
import type { Tool } from '#/capabilities/tools/types.ts';
import type { SessionGateway } from '#/channels/channel.ts';

import { join } from 'node:path';
import { createLogger } from '@monad/logger';

import { createInterruptServices } from '#/agent/approvals/interrupts.ts';
import { createConfigWatchers } from '#/agent/config.ts';
import { applyAcpDelegateTool } from '#/agent/delegation/acp-tool.ts';
import { createAgentExecutionService } from '#/agent/execution.ts';
import { createMemorySubsystem } from '#/agent/memory/subsystem.ts';
import { buildServiceTools } from '#/capabilities/tools';
import { configureToolBackends } from '#/capabilities/tools/configure-backends.ts';
import { createChannelGateway } from '#/channels/gateway.ts';
import { createHotReload } from '#/config/application.ts';
import { createCommandBundle } from '#/handlers/commands/bundle.ts';
import { createHookRunner } from '#/hooks/runner.ts';
import { initObservability, resolveObservabilityEndpoint } from '#/infra/observability.ts';
import { DelegationService } from '#/services/delegation/delegation.ts';
import { createPeerDelegateTools } from '#/services/delegation/peers.ts';
import { acpAgentCandidatesFromAdapters } from '#/services/delegation/presets.ts';
import { EventBus } from '#/services/event-bus.ts';
import { createLocaleService } from '#/services/i18n-loader.ts';
import { createGraphQueryTools } from '#/services/memory/graph/query-tools.ts';
import { createMemoryAgentTools } from '#/services/memory/tools.ts';
import { RoundCache } from '#/services/round-cache.ts';
import { ScheduleService } from '#/services/scheduling/schedule.ts';
import { warnIfNotInitialized } from '#/store/home/init-status.ts';
import { startStartupHousekeeping } from '#/store/home/startup-housekeeping.ts';
