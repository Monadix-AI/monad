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
  SearchSkillsResponse,
  SkillDetail,
  SkillMarketplaceSource,
  SkillSortMode,
  StatsRange
} from '@monad/protocol';
import type { EmbedResult, ModelMessage, ModelResult, ToolSpec } from '@monad/sdk-atom';
import type { DaemonHandlerDeps } from './handlers-deps.ts';

import { join } from 'node:path';
import { DEFAULT_SKILL_MARKETPLACE_SOURCE, MONAD_VERSION } from '@monad/protocol';

import { createProjectSessionOperations } from '#/atoms/experience-project-sessions.ts';
import { createExperienceStateStore, createExperienceWorkerScheduler } from '#/atoms/experience-state.ts';
import { ExperienceWorkerRegistry } from '#/atoms/experience-workers.ts';
import { createSkillCatalogs } from '#/capabilities/skills/index.ts';
import { createWorkspaceExperienceApiContext } from '#/handlers/atom-pack/experience-capabilities.ts';
import { createAtomPacksModule } from '#/handlers/atom-pack/index.ts';
import { createExternalAgentModule } from '#/handlers/external-agent/index.ts';
import { HandlerError } from '#/handlers/handler-error.ts';
import { createMemoryModule } from '#/handlers/memory/index.ts';
import { createSessionModule } from '#/handlers/session/index.ts';
import { createAcpAgentModule } from '#/handlers/settings/acp-agent/index.ts';
import { createAgentModule } from '#/handlers/settings/agent/index.ts';
import { createAppearanceModule } from '#/handlers/settings/appearance/index.ts';
import { createBrowserPresetModule } from '#/handlers/settings/browser-preset/index.ts';
import { createCapabilityInventoryModule } from '#/handlers/settings/capability-inventory/index.ts';
import { createChannelModule } from '#/handlers/settings/channel/index.ts';
import { createComputerPresetModule } from '#/handlers/settings/computer-preset/index.ts';
import { createDeveloperModule } from '#/handlers/settings/developer/index.ts';
import { createExternalAgentSettingsModule } from '#/handlers/settings/external-agent/index.ts';
import { createHooksModule } from '#/handlers/settings/hooks/index.ts';
import { createSettingsImportModule } from '#/handlers/settings/import/index.ts';
import { createMcpServerModule } from '#/handlers/settings/mcp-server/index.ts';
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
import { resolveExternalAgentEnv } from '#/services/external-agent/env.ts';
import { ExternalAgentHost } from '#/services/external-agent/host/index.ts';
import { resolveExternalAgentManagedServerUrl } from '#/services/external-agent/host/session-launcher.ts';
import { externalAgentConfigToView } from '#/services/external-agent/index.ts';
import { managedProjectRuntimeWorkspace } from '#/services/external-agent/managed-project.ts';
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
  deps.modelService.setAuthPersistence(async (auth) => {
    await deps.configManager.updateAuth(() => auth);
  });
  const sandboxActivation = createConfigSandboxActivationService(deps.configManager);
  const externalAgentHost = new ExternalAgentHost({
    store: deps.store,
    bus: deps.bus,
    monadHome: paths.home,
    serverUrl: resolveExternalAgentManagedServerUrl({
      serverUrl: deps.externalAgentServerUrl,
      networkHttps: deps.networkHttps
    }),
    networkHttps: deps.networkHttps,
    agents: async () => {
      return deps.configManager.get().cfg.externalAgents.map(externalAgentConfigToView);
    },
    resolveAgentEnv: async (env) => resolveExternalAgentEnv(env, deps.configManager.get().auth ?? undefined),
    externalAgentProcessRegistryPath: `${paths.runtime}/external-agent-processes.json`,
    authProcessRegistryPath: `${paths.runtime}/external-agent-auth-processes.json`,
    authHeartbeatTimeoutMs: deps.externalAgentAuthHeartbeatTimeoutMs,
    authStatusTimeoutMs: deps.externalAgentAuthStatusTimeoutMs
  });
  void externalAgentHost.reconcileOrphanedSessions();
  process.on('exit', () => externalAgentHost.stopAll());

  const init = createInitHandlers(paths, mockMode, deps.log);

  const oversight = createOversightHandlers(deps.oversight);
  const clarify = createClarifyHandlers(deps.clarify);
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
    get(): Promise<GetLawsResponse> {
      return deps.getLaws();
    }
  };

  const graph = {
    get(): GetGraphResponse {
      const { nodes, edges } = deps.graphStore.snapshot();
      return {
        nodes: nodes.map((n) => ({ id: n.id, scope: n.scope, name: n.name, type: n.type, aliases: n.aliases })),
        edges: edges.map((e) => ({
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
          ? deps.commands.registry.list(deps.commands.skills(), deps.localeService.t, { filter: query.filter })
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
  const session = createSessionModule({ ...deps, externalAgentHost });
  const experienceCapabilities = {
    state: {
      forPack: (atomPackId: string) => createExperienceStateStore(deps.store, atomPackId)
    },
    projectSessions: {
      operations: () =>
        createProjectSessionOperations({ store: deps.store, sessions: session, oversight: deps.oversight })
    },
    workerScheduler: {
      forExperience: (atomPackId: string, experienceId: string) =>
        createExperienceWorkerScheduler(deps.store, atomPackId, experienceId)
    }
  };
  const experienceWorkers = deps.getExperienceWorkers
    ? new ExperienceWorkerRegistry({
        store: deps.store,
        contextFor: (atomPackId, permissions, experienceId) =>
          createWorkspaceExperienceApiContext({
            atomPackId,
            experienceId,
            permissions,
            deps: experienceCapabilities
          })
      })
    : null;
  const syncExperienceWorkers = (): void => {
    if (!experienceWorkers) return;
    experienceWorkers.clear();
    for (const registration of deps.getExperienceWorkers?.() ?? []) {
      experienceWorkers.register(registration.atomPackId, registration.permissions, registration.worker);
    }
  };
  syncExperienceWorkers();
  if (experienceWorkers) {
    const projectIds = deps.store.listWorkplaceProjects().map((project) => project.id);
    void experienceWorkers
      .startProjects(projectIds)
      .catch((error) => deps.log.warn({ error }, 'workspace Experience worker startup failed'));
    deps.bus.subscribeAll((event) => {
      const source = deps.store.getSession(event.sessionId);
      if (!source?.projectId) return;
      void experienceWorkers
        .publish({
          id: event.id,
          projectId: source.projectId,
          sessionId: event.sessionId,
          type: event.type,
          payload: event.payload,
          createdAt: event.at
        })
        .catch((error) => deps.log.warn({ error }, 'workspace Experience worker event failed'));
    });
    const wakeTimer = setInterval(() => {
      void experienceWorkers
        .deliverDueWakeups()
        .catch((error) => deps.log.warn({ error }, 'workspace Experience worker wake-up failed'));
    }, 1_000);
    wakeTimer.unref();
  }
  const transcriptProjector = createTranscriptProjector({
    store: deps.store,
    bus: deps.bus,
    cache: deps.cache
  });
  externalAgentHost.setManagedProjectOutputHandler(async (output) => {
    await session.completeManagedExternalAgentProviderMessage(output);
  });

  return {
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
    model: createModelModule({ ...deps, config: deps.configManager }),
    channel: createChannelModule({ channelService: deps.channelService, config: deps.configManager }),
    peer: createPeerModule({ config: deps.configManager }),
    acpAgent: createAcpAgentModule({ config: deps.configManager }),
    externalAgentSettings: createExternalAgentSettingsModule({
      config: deps.configManager,
      externalAgentSessions: externalAgentHost
    }),
    mcpServer: createMcpServerModule({
      config: deps.configManager,
      getMcpStatus: deps.getMcpStatus,
      mcpAuthorize: deps.mcpAuthorize,
      mcpReconnect: deps.mcpReconnect
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
    developer: createDeveloperModule(paths, deps.configManager),
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
    capabilityInventory: createCapabilityInventoryModule(paths),
    atoms: createAtomPacksModule({
      paths,
      experienceCapabilities,
      onChanged: deps.rediscoverAtomPacks
        ? async () => {
            await deps.rediscoverAtomPacks?.();
            syncExperienceWorkers();
          }
        : undefined,
      getConflicts: deps.getAtomConflicts,
      getAtomDetails: deps.getAtomDetails,
      getWorkspaceExperienceApiHandler: deps.getWorkspaceExperienceApiHandler,
      getWorkspaceExperienceApiRoute: deps.getWorkspaceExperienceApiRoute,
      getWorkspaceExperienceSnapshot: deps.getWorkspaceExperienceSnapshot,
      getWorkspaceExperiences: deps.getWorkspaceExperiences,
      config: deps.configManager,
      modelService: deps.modelService,
      sandboxActivation
    }),
    session,
    externalAgent: createExternalAgentModule({
      paths,
      host: externalAgentHost,
      store: deps.store,
      config: deps.configManager
    }),
    _nativeAgentStore: deps.store,
    _nativeAgentAttachmentRoots: (args: { sessionId: string; agentId: string; workingPath?: string | null }) => {
      const nativeSession = args.agentId
        ? deps.store
            .listExternalAgentSessionsForTranscriptTarget(args.sessionId)
            .find((session) => session.agentName === args.agentId)
        : null;
      const workingPath = args.workingPath ?? nativeSession?.workingPath;
      return [
        ...(workingPath ? [workingPath] : []),
        ...(args.agentId
          ? [
              managedProjectRuntimeWorkspace({
                monadHome: paths.home,
                projectId: args.sessionId,
                agentName: args.agentId
              })
            ]
          : [])
      ];
    },
    _transcriptProjector: transcriptProjector,
    memory: createMemoryModule(
      deps.memoryService,
      deps.memorySetBackend,
      deps.memorySetMem0Models,
      deps.memorySetGraph
    ),
    oversight,
    clarify,
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
