import type { MonadPaths, ObscuraConfig } from '@monad/home';
import type { Logger } from '@monad/logger';
import type {
  ApprovalMutationResponse,
  ApprovalScope,
  CommandsListResponse,
  EnvDepsStatusResponse,
  GetGraphResponse,
  GetHealthResponse,
  GetInitStatusResponse,
  GetLicensesResponse,
  GetMem0DataResponse,
  GetStatsResponse,
  GetUsageResponse,
  IndexerStatus,
  InstallEnvDepsRequest,
  InstallEnvDepsResponse,
  ListApprovalsResponse,
  ListSkillsQuery,
  ListSkillsResponse,
  McpServerStatus,
  MemoryBackendId,
  OkResponse,
  PickDirectoryResponse,
  SearchSkillsResponse,
  SetMem0ModelsRequest,
  SetMemoryGraphRequest,
  SkillDetail,
  SkillListInstance,
  SkillListItem,
  SkillMarketplaceSource,
  SkillSortMode,
  StatsRange
} from '@monad/protocol';
import type { EmbedResult, ModelMessage, ModelResult, ToolSpec } from '@monad/sdk-atom';
import type { AtomConflict } from '@/atoms/resolve.ts';
import type { ChannelService } from '@/channels/channel.ts';
import type { SessionDeps } from '@/handlers/session/index.ts';
import type { ModelDeps } from '@/handlers/settings/model/index.ts';
import type { ConfigBus } from '@/services/config-bus.ts';
import type { ClarifyService } from '@/services/generation/clarify.ts';
import type { I18nService } from '@/services/i18n.ts';
import type { L2Provider } from '@/services/memory/graph/types.ts';
import type { MemoryService } from '@/services/memory/index.ts';
import type { OversightService } from '@/services/oversight.ts';

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeInitStatus,
  initMonadHome,
  loadAll,
  loadAuth,
  pickDirectory,
  saveProfile,
  setMonadRoot
} from '@monad/home';
import { DEFAULT_SKILL_MARKETPLACE_SOURCE, MONAD_VERSION } from '@monad/protocol';

import { installEnvDeps } from '@/bootstrap/env-deps.ts';
import { createSkillCatalogs } from '@/capabilities/skills/index.ts';
import { createAtomPacksModule } from '@/handlers/atom-pack/index.ts';
import { HandlerError } from '@/handlers/handler-error.ts';
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
import { createSandboxModule } from '@/handlers/settings/sandbox/index.ts';
import { createSkillsSettingsModule } from '@/handlers/settings/skills/index.ts';
import { createToolBackendsModule } from '@/handlers/settings/tool-backends/index.ts';
import { resolveNativeCliAgentEnv } from '@/services/native-cli/env.ts';
import { NativeCliHost } from '@/services/native-cli/host.ts';
import licensesData from '../generated/licenses.json';

export { HandlerError } from '@/handlers/handler-error.ts';

export const VERSION: string = MONAD_VERSION;

export interface DaemonHandlerDeps extends SessionDeps, ModelDeps {
  // SessionDeps types `paths` as the narrow `{ config }?` while ModelDeps needs the full
  // MonadPaths; re-declare it here (the daemon always passes the full paths) so extending
  // both does not collide.
  paths: MonadPaths;
  /** Layered L1 memory service — backs the memory control API. */
  memoryService: MemoryService;
  /** L2 knowledge graph store — backs the read-only graph viewer. */
  graphStore: L2Provider;
  /** Assemble the read-only mem0 explorer view (entries + cluster projection + status). */
  getMem0Data: () => Promise<GetMem0DataResponse>;
  /** Persist + hot-apply the active memory backend (config write). */
  memorySetBackend: (backend: MemoryBackendId) => Promise<void>;
  /** Persist + hot-apply mem0's model selection (chosen from Monad's model registry). */
  memorySetMem0Models: (sel: SetMem0ModelsRequest) => Promise<void>;
  /** Persist + hot-apply the L2 knowledge-graph consolidation settings. */
  memorySetGraph: (sel: SetMemoryGraphRequest) => Promise<void>;
  mockMode?: boolean;
  /** Human-in-the-loop approval gate for high-risk tool calls. */
  oversight: OversightService;
  /** Agent → human free-text question channel (the `clarify_ask` tool). */
  clarify: ClarifyService;
  /** External IM channel gateway (Telegram, …) — for settings CRUD + live status. */
  channelService: ChannelService;
  /** Locale gateway — backs /v1/settings/locale + the web catalog endpoint. */
  localeService: I18nService;
  configBus?: ConfigBus;
  connectObscura?: (config: ObscuraConfig, command: string) => Promise<{ connected: boolean; tools: string[] }>;
  disconnectObscura?: () => Promise<void>;
  getObscuraStatus?: () => { connected: boolean; tools: string[] };
  /** Live MCP connection health (config + presets + file/pack + obscura) for the status endpoint. */
  getMcpStatus?: () => Promise<McpServerStatus[]>;
  /** Run the interactive OAuth flow for a config http oauth server, then reconnect it. */
  mcpAuthorize?: (name: string) => Promise<void>;
  /** Manually (re)connect a single config MCP server (retry a boot-time failure). */
  mcpReconnect?: (name: string) => Promise<void>;
  /** Re-discover atom packs after install/remove (refresh the channel registry without a restart). */
  rediscoverAtomPacks?: () => Promise<void>;
  /** Bare-name collisions surfaced from the last load sweep (for the conflict UI). */
  getAtomConflicts?: () => AtomConflict[];
  /** Workspace experiences registered by atom packs during the last load sweep. */
  getWorkspaceExperiences?: () => import('@monad/protocol').WorkspaceExperienceDefinition[];
  /** Clear all stored embeddings and kick the indexer to rebuild — invoked when the user switches
   *  the embedding model and opts to re-index from scratch. */
  reindexEmbeddings?: () => void;
  /** Live indexer state (pending count + running flag). Optional so mock/test setups can omit it. */
  indexerStatus?: () => IndexerStatus;
  skills: SkillListItem[];
  skillInstances?: SkillListInstance[];
  /** Daemon-level warnings surfaced through /health (e.g. TLS unavailable). */
  daemonWarnings?: string[];
  /** SHA-256 fingerprint of the active TLS cert, surfaced through /health for TOFU verification. */
  certFingerprint?: string;
  /** ISO-8601 expiry of the active TLS cert, surfaced through /health so clients can warn before it expires. */
  certExpiry?: string;
  /** Getter for background upgrade check result — populated asynchronously after startup. */
  getUpgradeInfo?: () => { latestVersion: string; latestVersionCheckedAt: string } | null;
  log: Logger;
}

export function createDaemonHandlers(deps: DaemonHandlerDeps) {
  const { paths, mockMode = false } = deps;
  const nativeCliHost = new NativeCliHost({
    store: deps.store,
    bus: deps.bus,
    agents: async () => {
      const cfg = await loadAll(paths.config, paths.profile);
      return cfg?.nativeCliAgents ?? [];
    },
    resolveAgentEnv: async (env) => resolveNativeCliAgentEnv(env, (await loadAuth(paths.auth)) ?? undefined),
    nativeCliProcessRegistryPath: `${paths.runtime}/native-cli-processes.json`,
    authProcessRegistryPath: `${paths.runtime}/native-cli-auth-processes.json`
  });
  nativeCliHost.reconcileOrphanedSessions();

  const init = {
    async status(): Promise<GetInitStatusResponse> {
      if (mockMode) return { initialized: true, missing: [], homePath: paths.home };
      const cfg = await loadAll(paths.config, paths.profile);
      const auth = cfg ? await loadAuth(paths.auth) : null;
      const status = cfg
        ? computeInitStatus(cfg, auth)
        : { initialized: false, missing: ['provider' as const, 'credential' as const, 'default' as const] };
      return { ...status, homePath: paths.home };
    },
    async setHome(newPath: string): Promise<OkResponse> {
      // Only allowed before initialization is complete.
      const cfg = await loadAll(paths.config, paths.profile);
      const auth = cfg ? await loadAuth(paths.auth) : null;
      const status = cfg ? computeInitStatus(cfg, auth) : { initialized: false, missing: [] };
      if (status.initialized) {
        throw new HandlerError('conflict', 'Already initialized — run monad reset to start over');
      }
      await setMonadRoot(newPath);
      await initMonadHome({
        ...paths,
        home: newPath,
        configs: `${newPath}/configs`,
        config: `${newPath}/configs/config.json`,
        profile: `${newPath}/configs/profile.json`,
        credentials: `${newPath}/credentials`,
        auth: `${newPath}/credentials/auth.json`,
        tls: `${newPath}/credentials/tls`,
        workspace: `${newPath}/agents/default`,
        providers: `${newPath}/atoms/providers`,
        skills: `${newPath}/atoms/skills`,
        atoms: `${newPath}/atoms`,
        agents: `${newPath}/agents`,
        cache: `${newPath}/cache`,
        runtime: `${newPath}/runtime`,
        db: `${newPath}/runtime/monad.sqlite`,
        sock: `${newPath}/runtime/monad.sock`,
        kvSock: `${newPath}/runtime/kv.sock`,
        pid: `${newPath}/runtime/monad.pid`
      });
      // Spawn detached so the child outlives this process.
      const proc = Bun.spawn(process.argv, { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
      proc.unref();
      setTimeout(() => process.exit(0), 100);
      return { ok: true };
    },
    async envDepsStatus(): Promise<EnvDepsStatusResponse> {
      const nodeState = existsSync(join(paths.bin, 'node'))
        ? ('installed' as const)
        : Bun.which('node') !== null
          ? ('found' as const)
          : ('missing' as const);
      const uvState = existsSync(join(paths.bin, 'uv'))
        ? ('installed' as const)
        : Bun.which('uv') !== null
          ? ('found' as const)
          : ('missing' as const);
      return { node: nodeState, uv: uvState };
    },
    async installEnvDepsHandler(req: InstallEnvDepsRequest): Promise<InstallEnvDepsResponse> {
      return installEnvDeps(paths.bin, req, deps.log);
    }
  };

  const oversight = {
    async approve({
      requestId,
      allow,
      reason,
      scope
    }: {
      requestId: string;
      allow: boolean;
      reason?: string;
      scope?: ApprovalScope;
    }): Promise<{ ok: boolean }> {
      return { ok: await deps.oversight.respond(requestId, allow, reason, scope) };
    },
    async list({ sessionId }: { sessionId?: string } = {}): Promise<ListApprovalsResponse> {
      return { rules: deps.oversight.listApprovals(sessionId) };
    },
    async revoke({ id }: { id: string }): Promise<ApprovalMutationResponse> {
      return { ok: await deps.oversight.revokeApproval(id) };
    },
    async clear({
      scope,
      agentId
    }: {
      scope?: 'session' | 'agent' | 'global';
      agentId?: string;
    } = {}): Promise<ApprovalMutationResponse> {
      const removed = await deps.oversight.clearApprovals({ scope, agentId });
      return { ok: true, removed };
    }
  };

  const clarify = {
    async respond({ requestId, answer }: { requestId: string; answer: string }): Promise<{ ok: boolean }> {
      return { ok: deps.clarify.respond(requestId, answer) };
    }
  };

  const system = {
    async pickDirectory({
      prompt,
      defaultPath
    }: {
      prompt?: string;
      defaultPath?: string;
    }): Promise<PickDirectoryResponse> {
      return { path: await pickDirectory({ prompt, defaultPath }) };
    }
  };

  // Reverse fs/terminal delegation responses from the ACP bridge (editor). `respond` settles a
  // pending fs/terminal request; `output` streams cumulative terminal output while it runs.
  const delegation = {
    async respond({
      requestId,
      ok,
      result,
      error
    }: {
      requestId: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    }): Promise<{ ok: boolean }> {
      return { ok: deps.delegation?.respond(requestId, ok, result, error) ?? false };
    },
    async output({ requestId, output }: { requestId: string; output: string }): Promise<{ ok: boolean }> {
      return { ok: deps.delegation?.output(requestId, output) ?? false };
    }
  };

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
      getWorkspaceExperiences: deps.getWorkspaceExperiences,
      configBus: deps.configBus,
      modelService: deps.modelService
    }),
    session: createSessionModule({ ...deps, nativeCliHost }),
    nativeCli: createNativeCliModule({ paths, host: nativeCliHost, store: deps.store }),
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
    usage,
    stats,
    embeddings,
    indexer,
    locale,
    modelDirect
  };
}
