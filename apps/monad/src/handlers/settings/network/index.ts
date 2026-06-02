import type { MonadPaths } from '@monad/home';
import type { NetworkSettings, SetNetworkSettingsRequest } from '@monad/protocol';
import type { ConfigBus } from '@/services/config-bus.ts';

import { generateRemoteToken, loadAll, loadAuth, saveSystemConfig } from '@monad/home';

function toNetworkSettings(
  cfg: NonNullable<Awaited<ReturnType<typeof loadAll>>>,
  restartRequired: boolean
): NetworkSettings {
  return {
    port: cfg.network.port,
    transport: cfg.network.transport,
    remoteAccess: {
      enabled: cfg.network.remoteAccess.enabled,
      token: cfg.network.remoteAccess.token,
      allowInsecureHttp: cfg.network.remoteAccess.allowInsecureHttp
    },
    restartRequired
  };
}

export function createNetworkModule(paths: MonadPaths, configBus?: ConfigBus) {
  async function getNetworkSettings(): Promise<NetworkSettings> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('network settings: config.json missing');
    return toNetworkSettings(cfg, false);
  }

  async function setNetworkSettings(req: SetNetworkSettingsRequest): Promise<NetworkSettings> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('network settings: config.json missing');

    if (req.remoteAccess) {
      const remote = cfg.network.remoteAccess;
      if (req.remoteAccess.allowInsecureHttp !== undefined) {
        remote.allowInsecureHttp = req.remoteAccess.allowInsecureHttp;
      }
      if (req.remoteAccess.enabled !== undefined) {
        remote.enabled = req.remoteAccess.enabled;
        if (req.remoteAccess.enabled && (!remote.token || req.remoteAccess.rotateToken)) {
          remote.token = generateRemoteToken();
        }
        if (!req.remoteAccess.enabled) {
          remote.token = null;
        }
      } else if (req.remoteAccess.rotateToken && remote.enabled) {
        remote.token = generateRemoteToken();
      }
    }

    await saveSystemConfig(paths.config, cfg);
    if (configBus) {
      await configBus.publish({ cfg, auth: await loadAuth(paths.auth) });
    }
    return toNetworkSettings(cfg, true);
  }

  return { getNetworkSettings, setNetworkSettings };
}
