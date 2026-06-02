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
  modelService.setConfigPersistence(async (nextCfg) => {
    await runtime.config.updateConfig(() => nextCfg);
  });
  const { registry, commandRegistry } = core.capabilities;
  const { skillList } = core.skills;

  await configureToolBackends(cfg, startupAuth);
  const bus = new EventBus();
  const sessionAttention = new SessionAttentionService({ store, bus });
  sessionAttention.start();
  const messageIngress = createMessageIngress({ store, bus });
  const messageLookup = new MessageLookup(store, ({ transcriptTargetId, actor }) => {
    if (actor.kind === 'user-client') return true;
    if (actor.kind === 'daemon-agent') return actor.sessionId === transcriptTargetId;
    return store.getMeshSession(actor.meshSessionId)?.transcriptTargetId === transcriptTargetId;
  });
  const cache = new RoundCache();
  const { oversight, clarify, reloadApprovalPolicy } = await createInterruptServices({
    paths,
    cfg,
    store,
    bus,
    messageIngress,
    interactions: core.interactions
  });
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
  const mcpConnections = [...[...core.mcp.config.connections.values()].map((entry) => entry.conn), ...core.mcp.files];
  await Promise.allSettled(
    mcpConnections.map(async (connection) => {
      for (const task of (await connection.tasks?.pendingDeliveries()) ?? []) {
        if (!task.sessionId || !task.recoveredAt || !store.getSession(task.sessionId)) continue;
        const key =
          task.status === 'completed'
            ? 'daemon.mcp.taskRecovered.completed'
            : task.status === 'failed'
              ? 'daemon.mcp.taskRecovered.failed'
              : task.status === 'cancelled'
                ? 'daemon.mcp.taskRecovered.cancelled'
                : 'daemon.mcp.taskRecovered.inputRequired';
        await messageIngress.deliver({
          transcriptTargetId: transcriptTargetIdSchema.parse(task.sessionId),
          idempotencyKey: messageIdempotencyKey('mcp-task-recovery', connection.name, task.taskId, task.recoveredAt),
          producer: { kind: 'system', subsystem: 'mcp-task-recovery' },
          role: 'assistant',
          type: 'text',
          text: i18nService.t(key, { server: connection.name, taskId: task.taskId }),
          includeInContext: false
        });
        await connection.tasks?.acknowledgeDelivery(task.taskId, task.recoveredAt);
      }
    })
  );
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
    baseTools: (): Tool[] => registry.toolList(),
    toolsVersion: () => registry.toolRevision,
    bus,
    messageIngress,
    messageLookup,
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
    toolAllowedForSession: (sessionId, name) => agentPersona.toolAllowed(sessionId, name, registry.sourceNameOf(name)),
    hookRunner,
    inboundApproval: () => inboundApprovalMode,
    workspacePromptSlots: (sessionId) => {
      const workspace = getWorkspacePromptSlots();
      const selectedAgent = agentPersona.resolvePromptSlots(sessionId);
      if (!selectedAgent) return workspace;
      return {
        agent: selectedAgent.agent || workspace.agent,
        user: selectedAgent.user || workspace.user
      };
    },
    credentialManifest: (sessionId) =>
      renderAgentCredentialManifest(agentPersona.credentialManifestFor(sessionId, runtime.config.get())) || undefined
  });

  const commandBundle = createCommandBundle({
    commandRegistry,
    skills: () => skillList,
    store,
    cfg,
    liveCfg: () => runtime.config.get().cfg,
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
    messageIngress,
    sessionGateway: session.read,
    logger
  });
  const channelService = await createChannelGateway({
    sessionGateway: session.read,
    store,
    registry: core.atoms.channelRegistry,
    bus,
    messageIngress,
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
    sessionAttention,
    messageIngress,
    messageLookup,
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
import { transcriptTargetIdSchema } from '@monad/protocol';

import { createInterruptServices } from '#/agent/approvals/interrupts.ts';
import { createConfigWatchers } from '#/agent/config.ts';
import { applyAcpDelegateTool } from '#/agent/delegation/acp-tool.ts';
import { createAgentExecutionService } from '#/agent/execution.ts';
import { createMemorySubsystem } from '#/agent/memory/subsystem.ts';
import { renderAgentCredentialManifest } from '#/agent/prompts.ts';
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
import { createMessageIngress, messageIdempotencyKey } from '#/services/messages/ingress.ts';
import { MessageLookup } from '#/services/messages/lookup.ts';
import { RoundCache } from '#/services/round-cache.ts';
import { ScheduleService } from '#/services/scheduling/schedule.ts';
import { SessionAttentionService } from '#/services/session-attention.ts';
import { warnIfNotInitialized } from '#/store/home/init-status.ts';
import { startStartupHousekeeping } from '#/store/home/startup-housekeeping.ts';
