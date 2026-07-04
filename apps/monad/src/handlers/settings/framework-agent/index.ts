import type { FrameworkAgentConfig, MonadConfig, MonadPaths } from '@monad/home';
import type {
  ListFrameworkAgentsResponse,
  OkResponse,
  SetFrameworkAgentEnabledRequest,
  UpsertFrameworkAgentRequest
} from '@monad/protocol';

import { loadAll, saveSystemConfig } from '@monad/home';

export interface FrameworkAgentDeps {
  paths: MonadPaths;
}

const toView = (agent: FrameworkAgentConfig) => agent;
const fromView = (agent: UpsertFrameworkAgentRequest['agent']): FrameworkAgentConfig => ({
  name: agent.name,
  provider: agent.provider,
  transport: agent.transport,
  command: agent.command,
  args: agent.args,
  env: agent.env,
  baseUrl: agent.baseUrl,
  tokenRef: agent.tokenRef,
  defaultModel: agent.defaultModel,
  enabled: agent.enabled,
  osSandbox: agent.osSandbox ?? false,
  forwardMcp: agent.forwardMcp ?? false
});

export function createFrameworkAgentModule({ paths }: FrameworkAgentDeps) {
  async function read(): Promise<MonadConfig> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('framework-agent settings: config.json missing');
    return cfg;
  }
  const commit = (cfg: MonadConfig): Promise<void> => saveSystemConfig(paths.config, cfg);

  return {
    async listFrameworkAgents(): Promise<ListFrameworkAgentsResponse> {
      const cfg = await read();
      return { agents: cfg.frameworkAgents.map(toView) };
    },

    async upsertFrameworkAgent({ agent }: UpsertFrameworkAgentRequest): Promise<OkResponse> {
      if (!agent.name.trim()) throw new Error('framework-agent name must not be blank');
      if (agent.transport !== 'http-openai-compat' && agent.transport !== 'custom' && !agent.command?.trim()) {
        throw new Error(`framework-agent "${agent.name}": command must not be blank`);
      }
      if (agent.transport === 'http-openai-compat' && !agent.baseUrl?.trim()) {
        throw new Error(`framework-agent "${agent.name}": baseUrl must not be blank`);
      }
      const cfg = await read();
      cfg.frameworkAgents = [
        ...cfg.frameworkAgents.filter((candidate) => candidate.name !== agent.name),
        fromView(agent)
      ];
      await commit(cfg);
      return { ok: true };
    },

    async setFrameworkAgentEnabled({
      name,
      enabled
    }: { name: string } & SetFrameworkAgentEnabledRequest): Promise<OkResponse> {
      const cfg = await read();
      cfg.frameworkAgents = cfg.frameworkAgents.map((agent) => (agent.name === name ? { ...agent, enabled } : agent));
      await commit(cfg);
      return { ok: true };
    },

    async removeFrameworkAgent({ name }: { name: string }): Promise<OkResponse> {
      const cfg = await read();
      cfg.frameworkAgents = cfg.frameworkAgents.filter((agent) => agent.name !== name);
      await commit(cfg);
      return { ok: true };
    }
  };
}
