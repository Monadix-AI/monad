import type { MonadAuth, MonadConfig, MonadPaths } from '@monad/home';
import type { ChannelService } from '@/channels/channel.ts';
import type { ConfigBus } from '@/services/config-bus.ts';

import { loadAll, loadAuth, saveAuth, saveProfile } from '@monad/home';

export interface ChannelDeps {
  paths: MonadPaths;
  channelService: ChannelService;
  configBus?: ConfigBus;
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

export function createChannelContext({ paths, channelService, configBus }: ChannelDeps): ChannelSettingsContext {
  async function read(): Promise<{ cfg: MonadConfig; auth: MonadAuth }> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('channel: config.json missing');
    const auth = (await loadAuth(paths.auth)) ?? emptyAuth();
    return { cfg, auth };
  }

  async function commit(cfg: MonadConfig, auth?: MonadAuth): Promise<void> {
    await saveProfile(paths.profile, cfg);
    if (auth) await saveAuth(paths.auth, auth);
    const resolvedAuth = auth ?? (await loadAuth(paths.auth)) ?? emptyAuth();
    if (configBus) {
      await configBus.publish({ cfg, auth: resolvedAuth });
    } else {
      await channelService.reload(cfg, resolvedAuth);
    }
  }

  async function commitAuth(cfg: MonadConfig, auth: MonadAuth): Promise<void> {
    auth.updatedAt = new Date().toISOString();
    await saveAuth(paths.auth, auth);
    if (configBus) {
      await configBus.publish({ cfg, auth });
    } else {
      await channelService.reload(cfg, auth);
    }
  }

  return { read, commit, commitAuth, service: channelService };
}
