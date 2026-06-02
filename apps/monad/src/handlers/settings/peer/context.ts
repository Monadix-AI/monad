import type { MonadAuth, MonadConfig } from '@monad/environment';
import type { ConfigAccess } from '#/config/manager.ts';

import { emptyAuth } from '@monad/environment';

export interface PeerDeps {
  config: ConfigAccess;
}

export interface PeerSettingsContext {
  read(): Promise<{ cfg: MonadConfig; auth: MonadAuth }>;
  /** Persist config (+ optional auth). Peers are system config: the delegate tool picks up
   *  changes on the next daemon start, so there is no live tool rebuild here. */
  commit(cfg: MonadConfig, auth?: MonadAuth): Promise<void>;
}

export function createPeerContext({ config }: PeerDeps): PeerSettingsContext {
  async function read(): Promise<{ cfg: MonadConfig; auth: MonadAuth }> {
    const { cfg, auth: storedAuth } = structuredClone(config.get());
    const auth = storedAuth ?? emptyAuth();
    return { cfg, auth };
  }

  async function commit(cfg: MonadConfig, auth?: MonadAuth): Promise<void> {
    await config.update((draft) => {
      draft.cfg = cfg;
      if (auth) draft.auth = auth;
    });
  }

  return { read, commit };
}
