import type { AcpAgentConfig, MonadConfig, MonadPaths } from '@monad/home';
import type {
  AcpAgentView,
  GetAcpAgentResponse,
  ListAcpAgentPresetsResponse,
  ListAcpAgentsResponse,
  OkResponse,
  SetAcpAgentEnabledRequest,
  UpsertAcpAgentRequest
} from '@monad/protocol';

import { loadAll, saveSystemConfig } from '@monad/home';

import { HandlerError } from '#/handlers/handler-error.ts';
import { listAcpAgentPresets, productIconForAcpAgent } from '#/services/delegation/presets.ts';

export interface AcpAgentDeps {
  paths: MonadPaths;
}

// External ACP agents are SYSTEM config (config.json). Writing here persists via saveSystemConfig,
// which trips the config.json watcher → configReloader → applyAcpDelegateTool, so an invite/edit/enable/
// disable/remove re-applies the `agent_acp_delegate` tool LIVE (no restart — see bootstrap/acp-delegate.ts).
// `env` values are `${env:NAME}` refs, not secrets, so the view is the full config — nothing to strip.
const toView = (a: AcpAgentConfig): AcpAgentView => ({
  name: a.name,
  productIcon: productIconForAcpAgent(a.name),
  command: a.command,
  args: a.args,
  env: a.env,
  cwd: a.cwd,
  enabled: a.enabled,
  osSandbox: a.osSandbox,
  forwardMcp: a.forwardMcp
});
const fromView = (v: AcpAgentView): AcpAgentConfig => ({
  name: v.name,
  command: v.command,
  args: v.args,
  env: v.env,
  cwd: v.cwd,
  enabled: v.enabled,
  osSandbox: v.osSandbox ?? false,
  forwardMcp: v.forwardMcp ?? false
});

export function createAcpAgentModule({ paths }: AcpAgentDeps) {
  async function read(): Promise<MonadConfig> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('acp-agent settings: config.json missing');
    return cfg;
  }
  // acpAgents live in the system slice → write config.json (not profile.json).
  const commit = (cfg: MonadConfig): Promise<void> => saveSystemConfig(paths.config, cfg);

  return {
    async listAcpAgents(): Promise<ListAcpAgentsResponse> {
      const cfg = await read();
      return { agents: cfg.acpAgents.map(toView) };
    },

    async getAcpAgent({ name }: { name: string }): Promise<GetAcpAgentResponse> {
      const cfg = await read();
      const found = cfg.acpAgents.find((a) => a.name === name);
      if (!found) throw new HandlerError('not_found', `ACP agent not found: ${name}`);
      return { agent: toView(found) };
    },

    // Turnkey invite presets (Codex / Claude Code) + same-machine detection. Read-only, no config
    // touch — the UI prefills an upsert from a chosen preset. (See services/delegation/presets.ts.)
    listAcpAgentPresets(): ListAcpAgentPresetsResponse {
      return { presets: listAcpAgentPresets() };
    },

    // Insert-or-replace by name (the agent's identity), like channel upsert.
    async upsertAcpAgent({ agent }: UpsertAcpAgentRequest): Promise<OkResponse> {
      // The wire schema only enforces min(1), which permits whitespace-only — reject that here so the
      // model-facing agent name and the spawned command are real (a blank name/command would register
      // an undelegatable, unspawnable entry).
      if (!agent.name.trim()) throw new Error('acp-agent name must not be blank');
      if (!agent.command.trim()) throw new Error(`acp-agent "${agent.name}": command must not be blank`);
      const cfg = await read();
      cfg.acpAgents = [...cfg.acpAgents.filter((a) => a.name !== agent.name), fromView(agent)];
      await commit(cfg);
      return { ok: true };
    },

    async setAcpAgentEnabled({ name, enabled }: { name: string } & SetAcpAgentEnabledRequest): Promise<OkResponse> {
      const cfg = await read();
      if (!cfg.acpAgents.some((a) => a.name === name)) {
        throw new HandlerError('not_found', `ACP agent not found: ${name}`);
      }
      cfg.acpAgents = cfg.acpAgents.map((a) => (a.name === name ? { ...a, enabled } : a));
      await commit(cfg);
      return { ok: true };
    },

    async removeAcpAgent({ name }: { name: string }): Promise<OkResponse> {
      const cfg = await read();
      if (!cfg.acpAgents.some((a) => a.name === name)) {
        throw new HandlerError('not_found', `ACP agent not found: ${name}`);
      }
      cfg.acpAgents = cfg.acpAgents.filter((a) => a.name !== name);
      await commit(cfg);
      return { ok: true };
    }
  };
}
