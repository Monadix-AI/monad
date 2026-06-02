import type { MonadConfig, MonadPaths } from '@monad/environment';
import type {
  NetworkRemoteUrl,
  NetworkRuntimeStatus,
  NetworkSettings,
  ProbeNetworkRequest,
  ProbeNetworkResponse,
  SetNetworkSettingsRequest
} from '@monad/protocol';
import type { ConfigAccess } from '#/config/manager.ts';

import {
  generateRemoteToken,
  getLanIp,
  getTailscaleIp,
  isLoopbackDaemonHost,
  validateDaemonNetworkSecurity
} from '@monad/environment';

import { HandlerError } from '#/handlers/handler-error.ts';
import { resolveTlsSetupForNetwork } from '#/transports/tls.ts';

type ProbeFetch = (input: Request | URL | string, init?: RequestInit) => Promise<Response>;

export interface NetworkModuleDeps {
  currentRuntimeStatus?: () => NetworkRuntimeStatus | undefined;
  networkAddresses?: () => { lan?: string; overlay?: string };
  probeFetch?: ProbeFetch;
}

function remoteUrlsFor(cfg: MonadConfig, addresses: { lan?: string; overlay?: string }): NetworkRemoteUrl[] {
  if (!cfg.network.remoteAccess.enabled) return [];
  const scheme = cfg.network.https.enabled === false ? 'http' : 'https';
  const port = cfg.network.port;
  return [
    ...(addresses.lan ? [{ kind: 'lan' as const, label: 'LAN', url: `${scheme}://${addresses.lan}:${port}` }] : []),
    ...(addresses.overlay
      ? [{ kind: 'overlay' as const, label: 'Tailscale', url: `${scheme}://${addresses.overlay}:${port}` }]
      : [])
  ];
}

function toNetworkSettings(cfg: MonadConfig, restartRequired: boolean, deps: NetworkModuleDeps = {}): NetworkSettings {
  const addresses = deps.networkAddresses?.() ?? { lan: getLanIp(), overlay: getTailscaleIp() };
  const runtime = deps.currentRuntimeStatus?.();
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
    remoteUrls: remoteUrlsFor(cfg, addresses),
    ...(runtime ? { runtime } : {}),
    restartRequired
  };
}

export function createNetworkModule(paths: MonadPaths, config: ConfigAccess, deps: NetworkModuleDeps = {}) {
  async function getNetworkSettings(): Promise<NetworkSettings> {
    const cfg = config.get().cfg;
    return toNetworkSettings(cfg, false, deps);
  }

  async function setNetworkSettings(req: SetNetworkSettingsRequest): Promise<NetworkSettings> {
    const cfg = structuredClone(config.get().cfg);
    const wasHttpsEnabled = cfg.network.https.enabled;
    const wasInsecureRemote = cfg.network.remoteAccess.enabled && !wasHttpsEnabled;
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
        if (req.remoteAccess.enabled && !remote.enabled && req.https?.enabled === undefined) {
          cfg.network.https.enabled = true;
        }
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

    const enablesInsecureRemote = cfg.network.remoteAccess.enabled && !cfg.network.https.enabled && !wasInsecureRemote;
    if (enablesInsecureRemote && req.confirmInsecureRemoteAccess !== true) {
      throw new HandlerError('invalid', 'Plain HTTP remote access requires explicit confirmation');
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
        remoteAccess: cfg.network.remoteAccess
      });
    } catch (err) {
      throw new HandlerError('invalid', err instanceof Error ? err.message : String(err));
    }

    // Validate TLS can actually be set up BEFORE persisting https.enabled=true. Otherwise the
    // config saves as HTTPS-enabled but the hot-reload apply (and next boot) fails to make a
    // cert, leaving the daemon in a broken/fail-closed state with no rollback.
    if (!wasHttpsEnabled && cfg.network.https.enabled) {
      try {
        await resolveTlsSetupForNetwork({ https: cfg.network.https, tlsDir: paths.tls });
      } catch (err) {
        throw new HandlerError('invalid', `HTTPS unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await config.updateConfig(() => cfg);
    return toNetworkSettings(cfg, false, deps);
  }

  async function probeNetwork(req: ProbeNetworkRequest): Promise<ProbeNetworkResponse> {
    const fetchImpl = deps.probeFetch ?? fetch;
    const start = performance.now();
    try {
      const url = new URL(req.url);
      url.pathname = '/health';
      url.search = '';
      url.hash = '';
      const res = await fetchImpl(url.toString(), {
        headers: req.token ? { authorization: `Bearer ${req.token}` } : undefined,
        signal: AbortSignal.timeout(5000)
      });
      return { ok: res.ok, status: res.status, latencyMs: Math.round(performance.now() - start) };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - start),
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  return { getNetworkSettings, probeNetwork, setNetworkSettings };
}
