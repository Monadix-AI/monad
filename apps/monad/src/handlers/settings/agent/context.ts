import type { MonadConfig, MonadPaths } from '@monad/home';
import type { ConfigReloader } from '#/config/reloader.ts';

import { loadAll, loadAuth, saveProfile } from '@monad/home';

export interface AgentDeps {
  paths: MonadPaths;
  configReloader?: ConfigReloader;
}

export interface AgentContext {
  /** Daemon paths — handlers need `paths.agents` to read/write each agent's AGENT.md. */
  paths: MonadPaths;
  read(): Promise<MonadConfig>;
  commit(cfg: MonadConfig): Promise<void>;
}

export function createAgentContext({ paths, configReloader }: AgentDeps): AgentContext {
  async function read(): Promise<MonadConfig> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('agent: config.json missing');
    return cfg;
  }

  async function commit(cfg: MonadConfig): Promise<void> {
    await saveProfile(paths.profile, cfg);
    if (configReloader) {
      await configReloader.publish({ cfg, auth: await loadAuth(paths.auth) });
    }
  }

  return { paths, read, commit };
}
