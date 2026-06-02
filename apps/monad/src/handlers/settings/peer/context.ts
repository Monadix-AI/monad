import type { MonadAuth, MonadConfig, MonadPaths } from '@monad/home';
import type { ConfigBus } from '@/services/config-bus.ts';

import { emptyAuth, loadAll, loadAuth, saveAuth, saveSystemConfig } from '@monad/home';

export interface PeerDeps {
  paths: MonadPaths;
  configBus?: ConfigBus;
}

export interface PeerSettingsContext {
  read(): Promise<{ cfg: MonadConfig; auth: MonadAuth }>;
  /** Persist config (+ optional auth). Peers are system config: the delegate tool picks up
   *  changes on the next daemon start, so there is no live tool rebuild here. */
  commit(cfg: MonadConfig, auth?: MonadAuth): Promise<void>;
}

export function createPeerContext({ paths, configBus }: PeerDeps): PeerSettingsContext {
  async function read(): Promise<{ cfg: MonadConfig; auth: MonadAuth }> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('peer: config.json missing');
    const auth = (await loadAuth(paths.auth)) ?? emptyAuth();
    return { cfg, auth };
  }

  async function commit(cfg: MonadConfig, auth?: MonadAuth): Promise<void> {
    await saveSystemConfig(paths.config, cfg);
    if (auth) await saveAuth(paths.auth, auth);
    if (configBus) {
      const resolvedAuth = auth ?? (await loadAuth(paths.auth)) ?? emptyAuth();
      await configBus.publish({ cfg, auth: resolvedAuth });
    }
  }

  return { read, commit };
}
