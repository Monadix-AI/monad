import type { MonadConfig, MonadPaths } from '@monad/environment';
import type { ConfigAccess } from '#/config/manager.ts';

export interface AgentDeps {
  paths: MonadPaths;
  config: ConfigAccess;
}

export interface AgentContext {
  /** Daemon paths — handlers need `paths.agents` to read/write each agent's AGENT.md. */
  paths: MonadPaths;
  read(): Promise<MonadConfig>;
  commit(cfg: MonadConfig): Promise<void>;
}

export function createAgentContext({ paths, config }: AgentDeps): AgentContext {
  async function read(): Promise<MonadConfig> {
    return structuredClone(config.get().cfg);
  }

  async function commit(cfg: MonadConfig): Promise<void> {
    await config.updateConfig(() => cfg);
  }

  return { paths, read, commit };
}
