import type { MonadConfig, MonadPaths } from '@monad/home';
import type { Logger } from '@monad/logger';
import type { ChannelService } from '#/channels/channel.ts';
import type { ConfigSnapshot } from '#/config/service.ts';
import type { AtomPackRegistry } from '#/handlers/atom-pack/index.ts';
import type { HookConfig } from '#/hooks/runner.ts';
import type { EmbeddingIndexer } from '#/services/embedding-indexer.ts';
import type { AgentPersonaService } from '#/services/generation/agent-persona.ts';
import type { I18nService } from '#/services/i18n.ts';
import type { Store } from '#/store/db/index.ts';

import { emptyAuth } from '@monad/home';

import { applyAcpDelegateTool } from '#/agent/delegation/acp-tool.ts';
import { configureToolBackends } from '#/capabilities/tools/configure-backends.ts';
import { acpAgentCandidatesFromAdapters } from '#/services/delegation/presets.ts';
import { configureDeveloperLogTransport } from '#/services/developer-log.ts';

// Wire the configReloader hot-reload subscriber now that all services are in scope. The bus fires on both
// file-watcher events (disk edits) and in-process commit() calls (settings API).
export function createHotReload(deps: {
  paths: MonadPaths;
  store: Store;
  agentPersona: AgentPersonaService;
  embeddingIndexer: EmbeddingIndexer;
  channelService: ChannelService;
  registry: AtomPackRegistry;
  i18nService: I18nService;
  logger: Logger;
  gate: Parameters<typeof applyAcpDelegateTool>[0]['gate'];
  reloadApprovalPolicy: (approvals: MonadConfig['agent']['approvals']) => void;
  setInboundApprovalMode: (mode: MonadConfig['openaiCompat']['approval']) => void;
  setHooksConfig: (config: HookConfig) => void;
  setPolicyHooksConfig: (config: HookConfig) => void;
  /** Re-sync Monadix provider agents (register/deregister per `visibility.public`) on config change. */
  runMonadixSync?: (cfg: MonadConfig) => Promise<void>;
}): (snapshot: ConfigSnapshot) => Promise<void> {
  const {
    paths,
    store,
    agentPersona,
    embeddingIndexer,
    channelService,
    registry,
    i18nService,
    logger,
    gate,
    reloadApprovalPolicy,
    setInboundApprovalMode,
    setHooksConfig,
    setPolicyHooksConfig,
    runMonadixSync
  } = deps;

  return async ({ cfg: freshCfg, auth: freshAuth }) => {
    configureDeveloperLogTransport(paths, freshCfg.developerMode === true);
    // Hot-apply the inbound-delegation approval policy (the agent gate reads this live).
    setInboundApprovalMode(freshCfg.openaiCompat.approval);
    // Agents may have been created/renamed/deleted — re-read their personas against the fresh config.
    await agentPersona.reload(freshCfg);
    // A `visibility.public` toggle (or agent add/remove) re-syncs Monadix provider registrations live.
    await runMonadixSync?.(freshCfg).catch((err: unknown) => logger.warn(`monad: monadix sync failed: ${err}`));
    // A newly-configured (or changed) embedding role should backfill existing messages.
    embeddingIndexer.kick();
    // Hot-reload the channel gateway (connect added, disconnect removed, reconnect changed).
    await channelService
      .reload(freshCfg, freshAuth ?? emptyAuth())
      .catch((err: unknown) => logger.warn(`monad: channel reload failed: ${err}`));
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
  };
}
