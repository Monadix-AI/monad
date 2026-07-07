import type { MonadPaths } from '@monad/home';
import type { NetworkSettings, SetNetworkSettingsRequest } from '@monad/protocol';
import type { ConfigBus } from '@/services/config-bus.ts';

import {
  generateRemoteToken,
  isLoopbackDaemonHost,
  loadAll,
  loadAuth,
  saveSystemConfig,
  validateDaemonNetworkSecurity
} from '@monad/home';

import { HandlerError } from '@/handlers/handler-error.ts';

function toNetworkSettings(
  cfg: NonNullable<Awaited<ReturnType<typeof loadAll>>>,
  restartRequired: boolean
): NetworkSettings {
  return {
    host: cfg.network.host,
    port: cfg.network.port,
    transport: cfg.network.transport,
    https: cfg.network.https,
    remoteAccess: {
      enabled: cfg.network.remoteAccess.enabled,
      token: cfg.network.remoteAccess.token
    },
    localHttpFallback: cfg.network.localHttpFallback,
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

    if (req.host !== undefined) {
      cfg.network.host = req.host;
    }

    if (req.https) {
      if (req.https.enabled !== undefined) {
        cfg.network.https.enabled = req.https.enabled;
      }
    }

    if (req.remoteAccess) {
      const remote = cfg.network.remoteAccess;
      if (req.remoteAccess.enabled !== undefined) {
        remote.enabled = req.remoteAccess.enabled;
        if (req.remoteAccess.enabled && (!remote.token || req.remoteAccess.rotateToken)) {
          remote.token = generateRemoteToken();
        }
        if (!req.remoteAccess.enabled) {
          remote.token = null;
          if (!isLoopbackDaemonHost(cfg.network.host)) cfg.network.host = '127.0.0.1';
        }
      } else if (req.remoteAccess.rotateToken && remote.enabled) {
        remote.token = generateRemoteToken();
      }
    }
    if (req.localHttpFallback) {
      if (req.localHttpFallback.enabled !== undefined) {
        cfg.network.localHttpFallback.enabled = req.localHttpFallback.enabled;
      }
      if (req.localHttpFallback.port !== undefined) {
        cfg.network.localHttpFallback.port = req.localHttpFallback.port;
      }
    }

    try {
      validateDaemonNetworkSecurity({
        host: cfg.network.host,
        https: cfg.network.https,
        remoteAccess: cfg.network.remoteAccess
      });
    } catch (err) {
      throw new HandlerError('invalid', err instanceof Error ? err.message : String(err));
    }

    await saveSystemConfig(paths.config, cfg);
    if (configBus) {
      await configBus.publish({ cfg, auth: await loadAuth(paths.auth) });
    }
    return toNetworkSettings(cfg, true);
  }

  return { getNetworkSettings, setNetworkSettings };
}
