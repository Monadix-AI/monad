import type {
  CommandsListResponse,
  GetGraphResponse,
  GetHealthResponse,
  GetLawsResponse,
  GetLicensesResponse,
  GetMem0DataResponse,
  GetStatsResponse,
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
import type { DaemonHandlerDeps } from '@/handlers/handlers-deps.ts';

import { join } from 'node:path';
import { loadAll, loadAuth, saveProfile } from '@monad/home';
import { DEFAULT_SKILL_MARKETPLACE_SOURCE, MONAD_VERSION } from '@monad/protocol';

import { createSkillCatalogs } from '@/capabilities/skills/index.ts';
import { createAtomPacksModule } from '@/handlers/atom-pack/index.ts';
import { HandlerError } from '@/handlers/handler-error.ts';
import { createInitHandlers } from '@/handlers/handlers-init.ts';
import {
  createClarifyHandlers,
  createDelegationHandlers,
  createOversightHandlers,
  createSystemHandlers
} from '@/handlers/handlers-oversight.ts';
import { createMemoryModule } from '@/handlers/memory/index.ts';
import { createNativeCliModule } from '@/handlers/native-cli/index.ts';
import { createSessionModule } from '@/handlers/session/index.ts';
import { createAcpAgentModule } from '@/handlers/settings/acp-agent/index.ts';
import { createAgentModule } from '@/handlers/settings/agent/index.ts';
import { createBrowserPresetModule } from '@/handlers/settings/browser-preset/index.ts';
import { createChannelModule } from '@/handlers/settings/channel/index.ts';
import { createComputerPresetModule } from '@/handlers/settings/computer-preset/index.ts';
import { createDeveloperModule } from '@/handlers/settings/developer/index.ts';
import { createHooksModule } from '@/handlers/settings/hooks/index.ts';
import { createSettingsImportModule } from '@/handlers/settings/import/index.ts';
import { createMcpServerModule } from '@/handlers/settings/mcp-server/index.ts';
import { createModelModule } from '@/handlers/settings/model/index.ts';
import { createNativeCliAgentModule } from '@/handlers/settings/native-cli-agent/index.ts';
import { createNetworkModule } from '@/handlers/settings/network/index.ts';
import { createObscuraModule } from '@/handlers/settings/obscura/index.ts';
import { createOpenaiCompatModule } from '@/handlers/settings/openai-compat/index.ts';
import { createPeerModule } from '@/handlers/settings/peer/index.ts';
import { createUserProfileModule } from '@/handlers/settings/profile/index.ts';
import { createSandboxModule } from '@/handlers/settings/sandbox/index.ts';
import { createSkillsSettingsModule } from '@/handlers/settings/skills/index.ts';
import { createStartupSettingsModule } from '@/handlers/settings/startup/index.ts';
import { createToolBackendsModule } from '@/handlers/settings/tool-backends/index.ts';
import { resolveNativeCliAgentEnv } from '@/services/native-cli/env.ts';
import { NativeCliHost } from '@/services/native-cli/host.ts';
import licensesData from '../generated/licenses.json';

export { HandlerError } from '@/handlers/handler-error.ts';

export const VERSION: string = MONAD_VERSION;

export type { DaemonHandlerDeps } from '@/handlers/handlers-deps.ts';

export function createDaemonHandlers(deps: DaemonHandlerDeps) {
  const { paths, mockMode = false } = deps;
  const nativeCliHost = new NativeCliHost({
    store: deps.store,
    bus: deps.bus,
    monadHome: paths.home,
    serverUrl: deps.nativeCliServerUrl ?? `http://127.0.0.1:${Bun.env.MONAD_PORT || '52749'}`,
    agents: async () => {
      const cfg = await loadAll(paths.config, paths.profile);
      return cfg?.nativeCliAgents ?? [];
    },
    resolveAgentEnv: async (env) => resolveNativeCliAgentEnv(env, (await loadAuth(paths.auth)) ?? undefined),
    nativeCliProcessRegistryPath: `${paths.runtime}/native-cli-processes.json`,
    authProcessRegistryPath: `${paths.runtime}/native-cli-auth-processes.json`,
    authHeartbeatTimeoutMs: deps.nativeCliAuthHeartbeatTimeoutMs
  });
  nativeCliHost.reconcileOrphanedSessions();

  const init = createInitHandlers(paths, mockMode, deps.log);

  const oversight = createOversightHandlers(deps.oversight);
  const clarify = createClarifyHandlers(deps.clarify);
  const system = createSystemHandlers();
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
  const skillsSettings = createSkillsSettingsModule(deps.paths, deps.configBus);

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
    async list(): Promise<CommandsListResponse> {
      return {
        commands: deps.commands ? deps.commands.registry.list(deps.commands.skills(), deps.localeService.t) : []
      };
    }
  };

  // Locale: a single global setting (cfg.locale) resolved against the registered language packs.
  // `set` persists + hot-reloads the i18n gateway so channel/command replies switch immediately;
  // `catalog` returns the raw message templates for a locale (the web UI formats them client-side).
  const locale = {
    async get(): Promise<{ locale: string }> {
      const cfg = await loadAll(paths.config, paths.profile);
      return { locale: cfg?.locale ?? 'en' };
    },
    async set({ locale: next }: { locale: string }): Promise<OkResponse> {
      const cfg = await loadAll(paths.config, paths.profile);
      if (!cfg) throw new HandlerError('invalid', 'config.json missing');
      cfg.locale = next;
      await saveProfile(paths.profile, cfg);
      if (deps.configBus) {
        await deps.configBus.publish({ cfg, auth: await loadAuth(paths.auth) });
      } else {
        deps.localeService.reload(cfg);
      }
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
    async get(): Promise<GetUsageResponse> {
      const entries = deps.store.ledger();
      return {
        totalCostUsd: entries.reduce((sum, e) => sum + e.costUsd, 0),
        totalInputTokens: entries.reduce((sum, e) => sum + e.inputTokens, 0),
        totalOutputTokens: entries.reduce((sum, e) => sum + e.outputTokens, 0),
        entries,
        breakdown: deps.store.ledgerBreakdown()
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
  const session = createSessionModule({ ...deps, nativeCliHost });
  nativeCliHost.setManagedProjectOutputHandler(async (output) => {
    await session.completeManagedNativeCliProviderMessage(output);
  });

  return {
    health: async (): Promise<GetHealthResponse> => {
      const upgradeInfo = deps.getUpgradeInfo?.();
      return {
        status: 'ok',
        version: VERSION,
        ...(deps.daemonWarnings?.length ? { warnings: deps.daemonWarnings } : {}),
        ...(deps.certFingerprint ? { certFingerprint: deps.certFingerprint } : {}),
        ...(deps.certExpiry ? { certExpiry: deps.certExpiry } : {}),
        ...(upgradeInfo
          ? { latestVersion: upgradeInfo.latestVersion, latestVersionCheckedAt: upgradeInfo.latestVersionCheckedAt }
          : {})
      };
    },
    init,
    agent: createAgentModule({ paths, ownerPrincipalId: deps.ownerPrincipalId, configBus: deps.configBus }),
    model: createModelModule(deps),
    channel: createChannelModule({ paths, channelService: deps.channelService, configBus: deps.configBus }),
    peer: createPeerModule({ paths, configBus: deps.configBus }),
    acpAgent: createAcpAgentModule({ paths }),
    nativeCliAgent: createNativeCliAgentModule({ paths }),
    mcpServer: createMcpServerModule({
      paths,
      getMcpStatus: deps.getMcpStatus,
      mcpAuthorize: deps.mcpAuthorize,
      mcpReconnect: deps.mcpReconnect
    }),
    browserPreset: createBrowserPresetModule(paths, deps.configBus),
    computerPreset: createComputerPresetModule(paths, deps.configBus),
    obscura: createObscuraModule({
      paths,
      connectObscura: deps.connectObscura,
      disconnectObscura: deps.disconnectObscura,
      getObscuraStatus: deps.getObscuraStatus
    }),
    openaiCompat: createOpenaiCompatModule(paths),
    network: createNetworkModule(paths, deps.configBus),
    toolBackends: createToolBackendsModule(paths, deps.configBus),
    sandbox: createSandboxModule(paths, deps.configBus),
    developer: createDeveloperModule(paths, deps.configBus),
    profile: createUserProfileModule(paths, deps.configBus),
    startup: createStartupSettingsModule({
      monadHome: paths.home,
      logPath: join(paths.logs, 'startup.log')
    }),
    hooks: createHooksModule(paths, deps.configBus),
    settingsImport: createSettingsImportModule({
      paths,
      configBus: deps.configBus,
      mcpReconnect: deps.mcpReconnect
    }),
    atoms: createAtomPacksModule({
      paths,
      onChanged: deps.rediscoverAtomPacks,
      getConflicts: deps.getAtomConflicts,
      getWorkspaceExperienceApiHandler: deps.getWorkspaceExperienceApiHandler,
      getWorkspaceExperiences: deps.getWorkspaceExperiences,
      configBus: deps.configBus,
      modelService: deps.modelService
    }),
    session,
    nativeCli: createNativeCliModule({ paths, host: nativeCliHost, store: deps.store }),
    _nativeAgentStore: deps.store,
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
