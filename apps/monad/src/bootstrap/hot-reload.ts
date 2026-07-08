import type { MonadConfig, MonadPaths } from '@monad/home';
import type { Logger } from '@monad/logger';
import type { ChannelService } from '#/channels/channel.ts';
import type { AtomPackRegistry } from '#/handlers/atom-pack/index.ts';
import type { HookConfig } from '#/hooks/runner.ts';
import type { ConfigBus } from '#/services/config-bus.ts';
import type { EmbeddingIndexer } from '#/services/embedding-indexer.ts';
import type { AgentPersonaService } from '#/services/generation/agent-persona.ts';
import type { I18nService } from '#/services/i18n.ts';
import type { ModelService } from '#/services/model.ts';
import type { Store } from '#/store/db/index.ts';
import type { resolveSkillState } from '#/store/home/skills.ts';

import { emptyAuth } from '@monad/home';

import { acpAgentCandidatesFromAdapters } from '#/services/delegation/presets.ts';
import { configureDeveloperLogTransport } from '#/services/developer-log.ts';
import { applyAcpDelegateTool } from './acp-delegate.ts';
import { type ConfigMcpHandle, reloadConfigMcpServers } from './mcp.ts';
import { configureToolBackends } from './tool-backends.ts';

type SkillStatePredicate = ReturnType<typeof resolveSkillState>;

// Wire the configBus hot-reload subscriber now that all services are in scope. The bus fires on both
// file-watcher events (disk edits) and in-process commit() calls (settings API).
export function registerHotReload(deps: {
  configBus: ConfigBus;
  paths: MonadPaths;
  store: Store;
  modelService: ModelService;
  agentPersona: AgentPersonaService;
  embeddingIndexer: EmbeddingIndexer;
  channelService: ChannelService;
  registry: AtomPackRegistry;
  i18nService: I18nService;
  logger: Logger;
  gate: Parameters<typeof applyAcpDelegateTool>[0]['gate'];
  computeSkillState: (c: MonadConfig) => SkillStatePredicate;
  reloadSkills: () => Promise<void>;
  reloadApprovalPolicy: (approvals: MonadConfig['agent']['approvals']) => void;
  setInboundApprovalMode: (mode: MonadConfig['openaiCompat']['approval']) => void;
  setSkillState: (state: SkillStatePredicate) => void;
  setHooksConfig: (config: HookConfig) => void;
  setPolicyHooksConfig: (config: HookConfig) => void;
  getConfigMcp: () => ConfigMcpHandle;
  setConfigMcp: (v: ConfigMcpHandle) => void;
  setConfigMcpHttp: (v: Set<string>) => void;
}): void {
  const {
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
    gate,
    computeSkillState,
    reloadSkills,
    reloadApprovalPolicy,
    setInboundApprovalMode,
    setSkillState,
    setHooksConfig,
    setPolicyHooksConfig,
    getConfigMcp,
    setConfigMcp,
    setConfigMcpHttp
  } = deps;

  configBus.subscribe(async ({ cfg: freshCfg, auth: freshAuth }) => {
    const prevEmbedding = modelService.embeddingModel;
    configureDeveloperLogTransport(paths, freshCfg.developerMode === true);
    // Hot-apply the inbound-delegation approval policy (the agent gate reads this live).
    setInboundApprovalMode(freshCfg.openaiCompat.approval);
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
    setSkillState(computeSkillState(freshCfg));
    await reloadSkills();
    // Hot-reload the channel gateway (connect added, disconnect removed, reconnect changed).
    await channelService
      .reload(freshCfg, freshAuth ?? emptyAuth())
      .catch((err: unknown) => logger.warn(`monad: channel reload failed: ${err}`));
    // Diff-reconnect config.json + preset MCP servers (connect added, disconnect removed, reconnect
    // changed) so a settings edit applies without a restart. Unchanged servers keep their live
    // subprocess/session — a model-only edit (which also fires this) bounces nothing.
    try {
      const configMcp = await reloadConfigMcpServers(
        getConfigMcp().connections,
        freshCfg,
        paths,
        registry,
        freshAuth ?? undefined
      );
      setConfigMcp(configMcp);
      setConfigMcpHttp(configMcp.seenHttp);
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
        adapterCandidates: acpAgentCandidatesFromAdapters(),
        gate,
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
    setHooksConfig(freshCfg.hooks ?? {});
    setPolicyHooksConfig(freshCfg.policyHooks ?? {});
    i18nService.reload(freshCfg);
    await configureToolBackends(freshCfg, freshAuth ?? undefined);
  });
}
