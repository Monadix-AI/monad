import type {
  CommandsListQuery,
  CommandsListResponse,
  GetGraphResponse,
  GetHealthResponse,
  GetLawsResponse,
  GetLicensesResponse,
  GetMem0DataResponse,
  GetStatsResponse,
  GetUsageQuery,
  GetUsageResponse,
  IndexerStatus,
  ListSkillsQuery,
  ListSkillsResponse,
  OkResponse,
  OptionalMemoryScopeQuery,
  SearchSkillsResponse,
  SessionId,
  SkillDetail,
  SkillMarketplaceSource,
  SkillSortMode,
  StatsRange
} from '@monad/protocol';
import type { EmbedResult, ModelMessage, ModelResult, ToolSpec } from '@monad/sdk-atom';
import type { DaemonHandlerDeps } from './handlers-deps.ts';

import { join } from 'node:path';
import { DEFAULT_SKILL_MARKETPLACE_SOURCE, MONAD_VERSION, newId } from '@monad/protocol';

import { createProjectMemberOperations } from '#/atoms/experience-project-members.ts';
import { createProjectSessionOperations } from '#/atoms/experience-project-sessions.ts';
import { createExperienceStateStore, createExperienceWorkerScheduler } from '#/atoms/experience-state.ts';
import { ExperienceWorkerRegistry } from '#/atoms/experience-workers.ts';
import { createSkillCatalogs } from '#/capabilities/skills/index.ts';
import { createWorkplaceExperienceApiContext } from '#/handlers/atom-pack/experience-capabilities.ts';
import { createAtomPacksModule } from '#/handlers/atom-pack/index.ts';
import { HandlerError } from '#/handlers/handler-error.ts';
import { createMemoryModule } from '#/handlers/memory/index.ts';
import { createMeshAgentModule } from '#/handlers/mesh-agent/index.ts';
import { createManagedProjectOutputHandler } from '#/handlers/session/handlers/managed-project-output-handler.ts';
import { createSessionModule } from '#/handlers/session/index.ts';
import { createAcpAgentModule } from '#/handlers/settings/acp-agent/index.ts';
import { createAgentModule } from '#/handlers/settings/agent/index.ts';
import { createAppearanceModule } from '#/handlers/settings/appearance/index.ts';
import { createBrowserPresetModule } from '#/handlers/settings/browser-preset/index.ts';
import { createChannelModule } from '#/handlers/settings/channel/index.ts';
import { createComputerPresetModule } from '#/handlers/settings/computer-preset/index.ts';
import { createCredentialModule } from '#/handlers/settings/credential/index.ts';
import { createDeveloperModule } from '#/handlers/settings/developer/index.ts';
import { createHooksModule } from '#/handlers/settings/hooks/index.ts';
import { createSettingsImportModule } from '#/handlers/settings/import/index.ts';
import { createImportInventoryModule } from '#/handlers/settings/import-inventory/index.ts';
import { createMcpServerModule } from '#/handlers/settings/mcp-server/index.ts';
import { createMeshAgentSettingsModule } from '#/handlers/settings/mesh-agent/index.ts';
import { createModelModule } from '#/handlers/settings/model/index.ts';
import { createNetworkModule } from '#/handlers/settings/network/index.ts';
import { createObscuraModule } from '#/handlers/settings/obscura/index.ts';
import { createOpenaiCompatModule } from '#/handlers/settings/openai-compat/index.ts';
import { createPeerModule } from '#/handlers/settings/peer/index.ts';
import { createUserProfileModule } from '#/handlers/settings/profile/index.ts';
import { createSandboxModule } from '#/handlers/settings/sandbox/index.ts';
import { createSkillsSettingsModule } from '#/handlers/settings/skills/index.ts';
import { createStartupSettingsModule } from '#/handlers/settings/startup/index.ts';
import { createToolBackendsModule } from '#/handlers/settings/tool-backends/index.ts';
import { createSystemUpgradeModule } from '#/handlers/system-upgrade.ts';
import { createTranscriptProjector } from '#/handlers/transcript/projector.ts';
import { createConfigSandboxActivationService } from '#/platform/sandbox/activation.ts';
import { makeEvent } from '#/services/event-bus.ts';
import { memoryScopeKey } from '#/services/memory/policy.ts';
import { resolveMeshAgentEnv } from '#/services/mesh-agent/env.ts';
import { meshFixtureCaptureDirectory } from '#/services/mesh-agent/fixture-paths.ts';
import { MeshAgentHost } from '#/services/mesh-agent/host/index.ts';
import { meshAgentConfigToView } from '#/services/mesh-agent/index.ts';
import { invitableMeshAgentConfigs } from '#/services/mesh-agent/invitable-agents.ts';
import { managedProjectRuntimeWorkspaces } from '#/services/mesh-agent/managed-project.ts';
import { resolveMeshAgentManagedServerUrl } from '#/services/mesh-agent/managed-server-url.ts';
import { createMessageIngress } from '#/services/messages/ingress.ts';
import { MessageLookup } from '#/services/messages/lookup.ts';
import { writeNativeAgentDirectMessageReceipt } from '#/services/native-agent/direct-message-receipt.ts';
import { nativeAgentMemberDeliveryCoordinatorFor } from '#/services/native-agent/member-delivery-coordinator.ts';
import { parseProjectAskAnswers } from '#/services/native-agent/project-ask-answers.ts';
import { createNativeAgentProjectAskRecovery } from '#/services/native-agent/project-ask-recovery.ts';
import { createNativeAgentSessionMembersService } from '#/services/native-agent/session-members.ts';
import licensesData from '../../../generated/licenses.json';
import { createInitHandlers } from './handlers-init.ts';
import {
  createClarifyHandlers,
  createDelegationHandlers,
  createOversightHandlers,
  createSystemHandlers
} from './handlers-oversight.ts';

export { HandlerError } from '#/handlers/handler-error.ts';

export const VERSION: string = MONAD_VERSION;

export type { DaemonHandlerDeps } from './handlers-deps.ts';

export function createDaemonHandlers(deps: DaemonHandlerDeps) {
  const { paths, mockMode = false } = deps;
  const { interactions } = deps;
  deps.modelService.setConfigPersistence(async (cfg) => {
    await deps.configManager.updateConfig(() => cfg);
  });
  const sandboxActivation = createConfigSandboxActivationService(deps.configManager);
  const meshAgentHost = new MeshAgentHost({
    store: deps.store,
    bus: deps.bus,
    monadHome: paths.home,
    serverUrl: resolveMeshAgentManagedServerUrl({
      serverUrl: deps.meshAgentServerUrl,
      networkHttps: deps.networkHttps
    }),
    networkHttps: deps.networkHttps,
    agents: async () => {
      return invitableMeshAgentConfigs(deps.configManager.get().cfg).map(meshAgentConfigToView);
    },
    resolveAgentEnv: async (env) => resolveMeshAgentEnv(env, deps.configManager.get().auth ?? undefined),
    developerMode: deps.configManager.get().cfg.developerMode,
    meshFixtureCaptureDirectory: meshFixtureCaptureDirectory(paths),
    meshAgentProcessRegistryPath: `${paths.runtime}/mesh-agent-processes.json`,
    meshAgentLiveStoreDirectory: `${paths.runtime}/mesh-agent-live-observation`,
    authProcessRegistryPath: `${paths.runtime}/mesh-agent-auth-processes.json`,
    authHeartbeatTimeoutMs: deps.meshAgentAuthHeartbeatTimeoutMs,
    authStatusTimeoutMs: deps.meshAgentAuthStatusTimeoutMs
  });
  void meshAgentHost.reconcileOrphanedSessions();
  const memberKeyReconcile = deps.store.reconcileNativeAgentMemberKeys();
  if (memberKeyReconcile.reconciled || memberKeyReconcile.failures || memberKeyReconcile.cleared) {
    deps.log.info(memberKeyReconcile, 'reconciled durable native-agent member keys to canonical projectMemberId');
  }
  deps.store.reconcileNativeAgentIngressAfterRestart();
  deps.store.reconcileNativeAgentAsksAfterRestart();
  // Runs after the orphan reconcile above has already stamped previously-live runtimes terminal.
  const bindingRuntimeRecovery = deps.store.reconcileSessionBindingRuntimesAfterRestart();
  if (bindingRuntimeRecovery.recovered || bindingRuntimeRecovery.skipped || bindingRuntimeRecovery.conflicts) {
    deps.log.info(bindingRuntimeRecovery, 'reconciled session binding runtime ownership after restart');
  }
  // Stopped explicitly via `_stopMeshAgents` in the graceful-shutdown sequence (transports/shutdown.ts),
  // before the store lifecycle module closes its DB connection — `stop()` below persists each mesh
  // session's exit state, so it must run while the store is still open. A `process.on('exit', ...)`
  // handler here would race the store's own exit handler with no ordering guarantee.

  const init = createInitHandlers(paths, mockMode, deps.log);
  const messageIngress = deps.messageIngress ?? createMessageIngress({ store: deps.store, bus: deps.bus });
  const messageLookup =
    deps.messageLookup ??
    new MessageLookup(deps.store, ({ transcriptTargetId, actor }) => {
      if (actor.kind === 'user-client') return true;
      if (actor.kind === 'daemon-agent') return actor.sessionId === transcriptTargetId;
      return deps.store.getMeshSession(actor.meshSessionId)?.transcriptTargetId === transcriptTargetId;
    });

  const oversight = createOversightHandlers(deps.oversight);
  const clarify = createClarifyHandlers(interactions);
  const systemUpgrade = createSystemUpgradeModule({
    cacheDir: join(paths.cache, 'upgrade'),
    detached: true,
    getUpgradeInfo: deps.getUpgradeInfo
  });
  const system = createSystemHandlers(systemUpgrade);
  const delegation = createDelegationHandlers(deps.delegation);

  const skillCatalogs = createSkillCatalogs();
  const skills = {
    async list(query: ListSkillsQuery = { scope: 'runtime' }): Promise<ListSkillsResponse> {
      const skillInstances = deps.skillInstances ?? [];
      if (query.scope !== 'runtime') {
        const sourceKinds = new Set(query.scope.split(','));
        return {
          skills: deps.skills,
          skillInstances: skillInstances.filter((skill) => sourceKinds.has(skill.sourceKind))
        };
      }
      return { skills: deps.skills, skillInstances };
    },
    async browse(
      sort: SkillSortMode,
      source: SkillMarketplaceSource = DEFAULT_SKILL_MARKETPLACE_SOURCE
    ): Promise<SearchSkillsResponse> {
      const results = await skillCatalogs[source].browse(sort);
      return { results, query: '', sort, source };
    },
    async search(
      query: string,
      sort: SkillSortMode | undefined,
      source: SkillMarketplaceSource = DEFAULT_SKILL_MARKETPLACE_SOURCE
    ): Promise<SearchSkillsResponse> {
      const results = await skillCatalogs[source].search(query, sort);
      return { results, query, sort, source };
    },
    async detail(id: string, source: SkillMarketplaceSource = DEFAULT_SKILL_MARKETPLACE_SOURCE): Promise<SkillDetail> {
      return skillCatalogs[source].detail(id);
    }
  };
  const skillsSettings = createSkillsSettingsModule(deps.configManager);

  const mem0Data = {
    get(): Promise<GetMem0DataResponse> {
      return deps.getMem0Data();
    }
  };

  const laws = {
    get(query?: OptionalMemoryScopeQuery): Promise<GetLawsResponse> {
      return deps.getLaws(query);
    }
  };

  const graph = {
    get(query?: OptionalMemoryScopeQuery): GetGraphResponse {
      const { nodes, edges } = deps.graphStore.snapshot();
      const requestedScope = memoryScopeKey(query);
      const scopedNodes = nodes.filter((node) => requestedScope === undefined || node.scope === requestedScope);
      const scopedEdges = edges.filter((edge) => requestedScope === undefined || edge.scope === requestedScope);
      return {
        nodes: scopedNodes.map((n) => ({ id: n.id, scope: n.scope, name: n.name, type: n.type, aliases: n.aliases })),
        edges: scopedEdges.map((e) => ({
          id: e.id,
          scope: e.scope,
          src: e.src,
          dst: e.dst,
          relation: e.relation,
          provClass: e.provClass,
          confidence: e.confidence
        }))
      };
    }
  };

  const licenses = {
    list: (): Promise<GetLicensesResponse> => Promise.resolve(licensesData as GetLicensesResponse)
  };

  // Unified command discovery: built-ins + atom pack commands + user-invocable skills. Every client
  // (ACP available_commands_update, web autocomplete, /help, CLI) derives from this one list.
  const commands = {
    async list(query: CommandsListQuery = { filter: 'enabled' }): Promise<CommandsListResponse> {
      return {
        commands: deps.commands
          ? (deps.commands.listCommands?.(query.sessionId, query.filter) ??
            deps.commands.registry.list(deps.commands.skills(), deps.localeService.t, { filter: query.filter }))
          : []
      };
    }
  };

  // Locale: a single global setting (cfg.locale) resolved against the registered language packs.
  // `set` persists + hot-reloads the i18n gateway so channel/command replies switch immediately;
  // `catalog` returns the raw message templates for a locale (the web UI formats them client-side).
  const locale = {
    async get(): Promise<{ locale: string }> {
      return { locale: deps.configManager.get().cfg.locale };
    },
    async set({ locale: next }: { locale: string }): Promise<OkResponse> {
      await deps.configManager.updateConfig((cfg) => {
        cfg.locale = next;
      });
      return { ok: true };
    },
    async list(): Promise<{ locales: { locale: string; name: string }[] }> {
      return { locales: deps.localeService.list() };
    },
    async catalog({ locale: loc }: { locale?: string }): Promise<{ locale: string; messages: Record<string, string> }> {
      const active = loc ?? deps.localeService.locale;
      return { locale: active, messages: deps.localeService.catalog(active) };
    }
  };

  // The global usage ledger ("账本"): cumulative real token/cost per provider+model. `reset` is the
  // only way to wipe it (manual billing restart); per-session usage lives on each session row.
  const usage = {
    async get(query: GetUsageQuery = {}): Promise<GetUsageResponse> {
      const entries = deps.store.ledger();
      const fullBreakdown = deps.store.ledgerBreakdown();
      const offset = query.offset ?? 0;
      const limit = query.limit ?? Math.max(1, fullBreakdown.length);
      const breakdown = fullBreakdown.slice(offset, offset + limit);
      return {
        totalCostUsd: entries.reduce((sum, e) => sum + e.costUsd, 0),
        totalInputTokens: entries.reduce((sum, e) => sum + e.inputTokens, 0),
        totalOutputTokens: entries.reduce((sum, e) => sum + e.outputTokens, 0),
        entries,
        breakdown,
        total: fullBreakdown.length,
        limit,
        offset
      };
    },
    async reset(): Promise<OkResponse> {
      deps.store.clearLedger();
      return { ok: true };
    }
  };

  const stats = {
    async get(range: StatsRange = 'all'): Promise<GetStatsResponse> {
      return deps.store.stats(range);
    }
  };

  const modelDirect = {
    async complete(messages: ModelMessage[], tools: ToolSpec[], model?: string): Promise<ModelResult> {
      return deps.modelService.router.complete({ model: model ?? '', messages, tools });
    }
  };

  const embeddings = {
    async reindex(): Promise<OkResponse> {
      deps.reindexEmbeddings?.();
      return { ok: true };
    },
    async embed(texts: string[]): Promise<EmbedResult> {
      const fn = deps.modelService.router.embed;
      if (!fn)
        throw new HandlerError('invalid', 'No embedding model configured — set the default profile embedding role');
      return fn.call(deps.modelService.router, texts);
    }
  };

  const indexer = {
    async status(): Promise<IndexerStatus> {
      return deps.indexerStatus?.() ?? { pending: 0, running: false };
    }
  };
  const session = createSessionModule({ ...deps, meshAgentHost, messageIngress, messageLookup });
  const nativeAgentProjectAskRecovery = createNativeAgentProjectAskRecovery({
    store: deps.store,
    coordinator: nativeAgentMemberDeliveryCoordinatorFor(deps.store),
    input: async (meshSessionId, prompt, onAccepted) => {
      await meshAgentHost.input(meshSessionId, { input: prompt }, { onAccepted });
    },
    writeDirectReceipt: async (directMessageId) => {
      const message = deps.store.getNativeAgentDirectMessage(directMessageId);
      if (!message) throw new Error(`Native-agent direct message not found: ${directMessageId}`);
      await writeNativeAgentDirectMessageReceipt({ message, store: deps.store, messageIngress });
    }
  });
  interactions.setRecoveredContinuation(async (recovery) => {
    try {
      const nativeAgentAsk = deps.store.getNativeAgentAsk(recovery.requestId);
      if (nativeAgentAsk) {
        const answers = parseProjectAskAnswers(nativeAgentAsk.questions, recovery.answer);
        deps.store.settleNativeAgentAsk({
          requestId: recovery.requestId,
          outcome: recovery.answer.trim() ? 'answered' : 'skipped',
          ...(recovery.answer.trim() ? { answers } : {})
        });
        await nativeAgentProjectAskRecovery.schedule(recovery.requestId, { includeOutcome: true });
        return;
      }
      if (recovery.origin.kind === 'managed-project') {
        const answerText = deps.store.getMessage(recovery.sessionId, recovery.answerMessageId)?.text ?? recovery.answer;
        await session.notifyManagedMeshAgentProjectMembers({
          sessionId: recovery.sessionId as SessionId,
          text: answerText,
          sender: { kind: 'human', name: 'Human' },
          triggerMessageId: recovery.answerMessageId
        });
        return;
      }
      await session.send({
        sessionId: recovery.sessionId as SessionId,
        text: '',
        continueFromHistory: true
      });
    } catch (error) {
      deps.log.warn({ error, requestId: recovery.requestId }, 'failed to continue a restored clarification');
    }
  });
  const experienceCapabilities = {
    state: {
      forPack: (atomPackId: string) => createExperienceStateStore(deps.store, atomPackId)
    },
    projectSessions: {
      operations: () =>
        createProjectSessionOperations({ store: deps.store, sessions: session, oversight: deps.oversight })
    },
    projectMembers: {
      operations: () =>
        createProjectMemberOperations({
          avatarStyle: () => deps.configManager.get().cfg.appearance.avatarStyle,
          meshAgents: () => invitableMeshAgentConfigs(deps.configManager.get().cfg).map(meshAgentConfigToView),
          store: deps.store,
          sessions: session
        })
    },
    interactions,
    workerScheduler: {
      forExperience: (atomPackId: string, experienceId: string) =>
        createExperienceWorkerScheduler(deps.store, atomPackId, experienceId)
    }
  };
  const experienceWorkers = deps.getExperienceWorkers
    ? new ExperienceWorkerRegistry({
        store: deps.store,
        contextFor: (atomPackId, permissions, experienceId) =>
          createWorkplaceExperienceApiContext({
            atomPackId,
            experienceId,
            permissions,
            deps: experienceCapabilities
          })
      })
    : null;
  const bindExperienceWorkers = (): void => {
    if (!experienceWorkers) return;
    for (const registration of deps.getExperienceWorkers?.() ?? []) {
      experienceWorkers.register(registration.atomPackId, registration.permissions, registration.worker);
    }
    experienceWorkers.resume();
  };
  // Rebinding closes admission and lets the in-flight deliveries finish against the pack that
  // accepted them before the replacement set takes over.
  const syncExperienceWorkers = async (): Promise<void> => {
    if (!experienceWorkers) return;
    await experienceWorkers.drain();
    bindExperienceWorkers();
  };
  bindExperienceWorkers();
  if (experienceWorkers) {
    const projectIds = deps.store.listWorkplaceProjects().map((project) => project.id);
    void experienceWorkers
      .startProjects(projectIds)
      .catch((error) => deps.log.warn({ error }, 'workplace experience worker startup failed'));
    deps.bus.subscribeAll((event) => {
      const source = deps.store.getSession(event.sessionId);
      const projectId = event.projectId ?? source?.projectId;
      if (!projectId) return;
      void experienceWorkers
        .publish({
          id: event.id,
          projectId,
          sessionId: event.sessionId,
          type: event.type,
          payload: event.payload,
          createdAt: event.at
        })
        .catch((error) => deps.log.warn({ error }, 'workplace experience worker event failed'));
    });
    const wakeTimer = setInterval(() => {
      void experienceWorkers
        .deliverDueWakeups()
        .catch((error) => deps.log.warn({ error }, 'workplace experience worker wake-up failed'));
    }, 1_000);
    wakeTimer.unref();
  }
  const transcriptProjector = createTranscriptProjector({
    messageIngress
  });
  const nativeAgentSessionMembers = createNativeAgentSessionMembersService({
    meshAgents: () => invitableMeshAgentConfigs(deps.configManager.get().cfg).map(meshAgentConfigToView),
    store: deps.store
  });
  meshAgentHost.setManagedProjectOutputHandler(
    createManagedProjectOutputHandler({
      getMeshSession: (meshSessionId) => deps.store.getMeshSession(meshSessionId),
      completeProviderMessage: (input) => session.completeManagedMeshAgentProviderMessage(input),
      warn: (fields, message) => deps.log.warn(fields, message)
    })
  );
  meshAgentHost.setManagedProjectLoopEventHandler((event) => {
    if (!event.sessionId.startsWith('ses_')) return;
    session.applyManagedAgentLoopEvent({
      sessionId: event.sessionId,
      meshSessionId: event.meshSessionId,
      memberId: event.memberId,
      ...(event.kind === 'output'
        ? { kind: 'output' as const, event: event.event }
        : { kind: 'runtime' as const, snapshot: event.snapshot })
    });
  });
  const meshAgentSettings = createMeshAgentSettingsModule({
    config: deps.configManager,
    meshSessions: meshAgentHost,
    onCatalogUpdated: (resources) => {
      deps.bus.publish(
        makeEvent(newId('ses'), 'mesh.catalog.updated', { resources, updatedAt: new Date().toISOString() })
      );
    }
  });

  return {
    /** Drain the running experience workers and rebind them to the current registry contents.
     *  Exposed so a rediscovery sweep triggered outside the atom-pack API (the fs watcher) rebinds
     *  them too, instead of leaving the previous packs' workers running. */
    syncExperienceWorkers,
    health: async (): Promise<GetHealthResponse> => {
      const upgradeInfo = deps.getUpgradeInfo?.();
      const cfg = deps.configManager.get().cfg;
      const httpsDisabled = cfg.network.https.enabled === false;
      const certFingerprint = deps.getCertFingerprint?.() ?? deps.certFingerprint;
      const certExpiry = deps.getCertExpiry?.() ?? deps.certExpiry;
      const warnings = [...(deps.getDaemonWarnings?.() ?? deps.daemonWarnings ?? [])];
      if (httpsDisabled && !warnings.includes('tls:https-disabled')) warnings.push('tls:https-disabled');
      return {
        status: 'ok',
        version: VERSION,
        ...(warnings.length ? { warnings } : {}),
        ...(deps.getNetworkRuntimeStatus?.() ? { networkRuntime: deps.getNetworkRuntimeStatus() } : {}),
        ...(httpsDisabled ? { certStatus: 'disabled' as const } : {}),
        ...(!httpsDisabled && (certFingerprint || certExpiry) ? { certStatus: 'active' as const } : {}),
        ...(certFingerprint ? { certFingerprint } : {}),
        ...(certExpiry ? { certExpiry } : {}),
        ...(upgradeInfo
          ? { latestVersion: upgradeInfo.latestVersion, latestVersionCheckedAt: upgradeInfo.latestVersionCheckedAt }
          : {})
      };
    },
    init,
    agent: createAgentModule({ paths, config: deps.configManager }),
    credential: createCredentialModule(deps.configManager),
    model: createModelModule({ ...deps, config: deps.configManager }),
    channel: createChannelModule({ channelService: deps.channelService, config: deps.configManager }),
    peer: createPeerModule({ config: deps.configManager }),
    acpAgent: createAcpAgentModule({ config: deps.configManager }),
    meshAgentSettings,
    mcpServer: createMcpServerModule({
      config: deps.configManager,
      getMcpStatus: deps.getMcpStatus,
      mcpAuthorize: deps.mcpAuthorize,
      mcpReconnect: deps.mcpReconnect,
      mcpTaskObserve: deps.mcpTaskObserve,
      mcpTaskCancel: deps.mcpTaskCancel
    }),
    browserPreset: createBrowserPresetModule(deps.configManager),
    computerPreset: createComputerPresetModule(deps.configManager),
    obscura: createObscuraModule({
      paths,
      config: deps.configManager,
      connectObscura: deps.connectObscura,
      disconnectObscura: deps.disconnectObscura,
      getObscuraStatus: deps.getObscuraStatus
    }),
    openaiCompat: createOpenaiCompatModule(deps.configManager),
    network: createNetworkModule(paths, deps.configManager),
    appearance: createAppearanceModule(deps.configManager),
    toolBackends: createToolBackendsModule(deps.configManager),
    sandbox: createSandboxModule(deps.configManager, sandboxActivation),
    developer: createDeveloperModule(paths, deps.configManager, deps.logMaintenance),
    profile: createUserProfileModule(deps.configManager),
    startup: createStartupSettingsModule({
      monadHome: paths.home,
      logPath: join(paths.logs, 'startup.log')
    }),
    hooks: createHooksModule(deps.configManager),
    settingsImport: createSettingsImportModule({
      paths,
      config: deps.configManager,
      mcpReconnect: deps.mcpReconnect
    }),
    importInventory: createImportInventoryModule(paths),
    atoms: createAtomPacksModule({
      paths,
      experienceCapabilities,
      onChanged: deps.rediscoverAtomPacks
        ? async () => {
            await deps.rediscoverAtomPacks?.();
            await syncExperienceWorkers();
          }
        : undefined,
      getConflicts: deps.getAtomConflicts,
      getAtomDetails: deps.getAtomDetails,
      getWorkplaceExperienceApiHandler: deps.getWorkplaceExperienceApiHandler,
      getWorkplaceExperienceApiRoute: deps.getWorkplaceExperienceApiRoute,
      getWorkplaceExperienceSnapshot: deps.getWorkplaceExperienceSnapshot,
      getWorkplaceExperiences: deps.getWorkplaceExperiences,
      config: deps.configManager,
      modelService: deps.modelService,
      sandboxActivation
    }),
    session,
    meshAgent: createMeshAgentModule({
      paths,
      host: meshAgentHost,
      store: deps.store,
      config: deps.configManager
    }),
    _stopMeshAgents: () => meshAgentHost.stopAll(),
    _nativeAgentStore: deps.store,
    _nativeAgentEventBus: deps.bus,
    _nativeAgentSessionMembers: nativeAgentSessionMembers,
    _nativeAgentAttachmentRoots: (args: {
      sessionId: string;
      projectMemberId: string;
      workingPath?: string | null;
    }) => {
      const nativeSession = args.projectMemberId
        ? deps.store
            .listMeshSessionsForTranscriptTarget(args.sessionId)
            .find((session) => session.projectMemberId === args.projectMemberId)
        : null;
      const workingPath = args.workingPath ?? nativeSession?.workingPath;
      const projectId = deps.store.getSession(args.sessionId)?.projectId;
      const workspaces =
        nativeSession && projectId
          ? managedProjectRuntimeWorkspaces({
              monadHome: paths.home,
              projectId,
              sessionId: args.sessionId,
              agentId: nativeSession.projectMemberId ?? nativeSession.agentName
            })
          : null;
      return [
        ...(workingPath ? [workingPath] : []),
        ...(workspaces ? [workspaces.shared, workspaces.agent, workspaces.session, workspaces.runtime] : [])
      ];
    },
    _transcriptProjector: transcriptProjector,
    _messageIngress: messageIngress,
    _messageLookup: messageLookup,
    memory: createMemoryModule(
      deps.memoryService,
      deps.memoryPrepareBackend,
      deps.memorySetBackend,
      deps.memorySetMem0Models
    ),
    oversight,
    clarify,
    // The interaction authority itself (not just its handler group) so the transport binds the same
    // instance the handlers use — see createHttpTransport.
    interactions,
    system,
    delegation,
    skills,
    skillsSettings,
    commands,
    licenses,
    graph,
    mem0Data,
    laws,
    usage,
    stats,
    embeddings,
    indexer,
    locale,
    modelDirect
  };
}
