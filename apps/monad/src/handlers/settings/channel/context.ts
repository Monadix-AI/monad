import type { MonadAuth, MonadConfig } from '@monad/environment';
import type { ChannelService } from '#/channels/channel.ts';
import type { ConfigAccess } from '#/config/manager.ts';

export interface ChannelDeps {
  channelService: ChannelService;
  config: ConfigAccess;
}

export interface ChannelSettingsContext {
  read(): Promise<{ cfg: MonadConfig; auth: MonadAuth }>;
  /** Persist config (+ optional auth) then live-reload the channel gateway. */
  commit(cfg: MonadConfig, auth?: MonadAuth): Promise<void>;
  commitAuth(cfg: MonadConfig, auth: MonadAuth): Promise<void>;
  readonly service: ChannelService;
}

function emptyAuth(): MonadAuth {
  return { version: 1, activeProvider: null, updatedAt: new Date().toISOString(), credentialPool: {} };
}

export function createChannelContext({ channelService, config }: ChannelDeps): ChannelSettingsContext {
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

  async function commitAuth(cfg: MonadConfig, auth: MonadAuth): Promise<void> {
    auth.updatedAt = new Date().toISOString();
    await config.update((draft) => {
      draft.cfg = cfg;
      draft.auth = auth;
    });
  }

  return { read, commit, commitAuth, service: channelService };
}
