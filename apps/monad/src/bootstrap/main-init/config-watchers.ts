// Live config-derived state: the skill auto-load predicate, hot-swappable command/policy hook
// config, the config/profile/auth file watcher (feeding the shared ConfigBus), workspace prompt
// slots (SOUL.md / AGENT.md / USER.md), and per-agent persona resolution. Everything here is a
// `let` swapped in place on a settings hot-reload so the running agent picks up edits without a
// restart — accessors are exposed as getters/setters rather than the raw bindings so callers in
// main.ts keep reading the CURRENT value, not a snapshot taken at construction time.

import type { MonadConfig, MonadPaths } from '@monad/home';
import type { Logger } from '@monad/logger';
import type { HookConfig } from '#/hooks/runner.ts';
import type { ReloadService } from '#/reload/index.ts';
import type { Store } from '#/store/db/index.ts';

import { loadAll, loadAuth } from '@monad/home';

import { ConfigBus } from '#/services/config-bus.ts';
import { AgentPersonaService } from '#/services/generation/agent-persona.ts';
import { resolveSkillState } from '#/store/home/skills.ts';
import { loadWorkspacePromptSlots, WORKSPACE_CONTEXT_FILES } from '#/store/home/workspace-context.ts';

type SkillState = ReturnType<typeof resolveSkillState>;
type WorkspacePromptSlots = Awaited<ReturnType<typeof loadWorkspacePromptSlots>>;

export interface ConfigWatchers {
  configBus: ConfigBus;
  computeSkillState: (c: MonadConfig) => SkillState;
  getSkillState: () => SkillState;
  setSkillState: (state: SkillState) => void;
  getHooksConfig: () => HookConfig;
  setHooksConfig: (config: HookConfig) => void;
  getPolicyHooksConfig: () => HookConfig;
  setPolicyHooksConfig: (config: HookConfig) => void;
  getWorkspacePromptSlots: () => WorkspacePromptSlots;
  agentPersona: AgentPersonaService;
}

export async function createConfigWatchers(deps: {
  paths: MonadPaths;
  cfg: MonadConfig;
  store: Store;
  reloadService: ReloadService;
  logger: Logger;
  configBus?: ConfigBus;
  watchSettings?: boolean;
}): Promise<ConfigWatchers> {
  const { paths, cfg, store, reloadService, logger } = deps;

  // Effective skill state resolver (global master + per-instance switches, overridden by the
  // active agent's switches). A `let` so a config.json edit can swap it in and re-map skills
  // without a restart.
  const computeSkillState = (c: MonadConfig) =>
    resolveSkillState({
      global: c.skills,
      agent: c.agent.agents.find((a) => a.id === c.agent.defaultAgentId)?.skills
    });
  let skillState = computeSkillState(cfg);
  // Command-hook config, swapped in place on a settings reload so config.json `hooks` edits
  // hot-apply without a restart (the HookRunner reads it via a getter each call).
  let hooksConfig: HookConfig = cfg.hooks ?? {};
  // Operator-managed policy hooks — same hot-swap discipline, but a separate field the hooks
  // settings API never writes, so user edits can't remove an org-enforced rule.
  let policyHooksConfig: HookConfig = cfg.policyHooks ?? {};

  // In-process pub/sub for config/profile changes. Shared by the file-watcher and commit() paths
  // so both trigger the exact same set of reload callbacks.
  const configBus = deps.configBus ?? new ConfigBus((err) => logger.warn(`monad: config-bus listener error: ${err}`));

  // Watch the home dir, not the files directly, so atomic rename-replace writes are caught.
  // Network/sandbox/principal settings are NOT hot-applied (wired at boot) — those need a restart.
  if (deps.watchSettings !== false) {
    reloadService.register({
      name: 'settings',
      path: paths.home,
      filter: (filename) =>
        filename === 'config.json' ||
        filename === 'profile.json' ||
        filename === 'sandbox.json' ||
        filename === 'auth.json',
      onChange: async () => {
        const [freshCfg, freshAuth] = await Promise.all([loadAll(paths.config, paths.profile), loadAuth(paths.auth)]);
        if (!freshCfg) return;
        await configBus.publish({ cfg: freshCfg, auth: freshAuth });
        logger.info('monad: hot-reloaded settings from disk');
      }
    });
  }

  // User-editable prompt slots from the workspace root — SOUL.md, AGENT.md/AGENTS.md, USER.md.
  // A `let` so an edit hot-reloads without rebuilding the agent.
  let workspacePromptSlots = await loadWorkspacePromptSlots(paths.workspace);
  reloadService.register({
    name: 'workspace-context',
    path: paths.workspace,
    filter: (filename) => Boolean(filename && WORKSPACE_CONTEXT_FILES.includes(filename)),
    onChange: async () => {
      workspacePromptSlots = await loadWorkspacePromptSlots(paths.workspace);
      logger.info('monad: hot-reloaded workspace prompt slots (SOUL.md / AGENT.md / USER.md)');
    }
  });

  // Per-agent persona (Studio): each session's bound agent contributes its own AGENT.md as the system
  // prompt, falling back to the global workspace identity. The cache is sync (the loop builds the
  // prompt per turn) and hot-reloads on agents-dir edits; the configBus subscriber re-reads on agent
  // create/rename/delete (an agent's row + dir may have changed).
  const agentPersona = new AgentPersonaService(paths, store);
  await agentPersona.reload(cfg);
  reloadService.register({
    name: 'agent-persona',
    path: paths.agents,
    filter: (filename) => Boolean(filename?.endsWith('AGENT.md')),
    onChange: async () => {
      await agentPersona.reload();
      logger.info('monad: hot-reloaded agent personas (AGENT.md)');
    }
  });

  return {
    configBus,
    computeSkillState,
    getSkillState: () => skillState,
    setSkillState: (state) => {
      skillState = state;
    },
    getHooksConfig: () => hooksConfig,
    setHooksConfig: (config) => {
      hooksConfig = config;
    },
    getPolicyHooksConfig: () => policyHooksConfig,
    setPolicyHooksConfig: (config) => {
      policyHooksConfig = config;
    },
    getWorkspacePromptSlots: () => workspacePromptSlots,
    agentPersona
  };
}
