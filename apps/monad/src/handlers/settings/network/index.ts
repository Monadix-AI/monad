import type { MonadPaths } from '@monad/home';
import type {
  NetworkRemoteUrl,
  NetworkRuntimeStatus,
  NetworkSettings,
  ProbeNetworkRequest,
  ProbeNetworkResponse,
  SetNetworkSettingsRequest
} from '@monad/protocol';
import type { ConfigReloader } from '#/config/reloader.ts';

import {
  generateRemoteToken,
  getLanIp,
  getTailscaleIp,
  isLoopbackDaemonHost,
  loadAll,
  loadAuth,
  saveSystemConfig,
  validateDaemonNetworkSecurity
} from '@monad/home';

import { resolveTlsSetupForNetwork } from '#/bootstrap/tls.ts';
import { HandlerError } from '#/handlers/handler-error.ts';

type ProbeFetch = (input: Request | URL | string, init?: RequestInit) => Promise<Response>;

export interface NetworkModuleDeps {
  currentRuntimeStatus?: () => NetworkRuntimeStatus | undefined;
  networkAddresses?: () => { lan?: string; overlay?: string };
  probeFetch?: ProbeFetch;
}

function remoteUrlsFor(
  cfg: NonNullable<Awaited<ReturnType<typeof loadAll>>>,
  addresses: { lan?: string; overlay?: string }
): NetworkRemoteUrl[] {
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

function toNetworkSettings(
  cfg: NonNullable<Awaited<ReturnType<typeof loadAll>>>,
  restartRequired: boolean,
  deps: NetworkModuleDeps = {}
): NetworkSettings {
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

export function createNetworkModule(paths: MonadPaths, configReloader?: ConfigReloader, deps: NetworkModuleDeps = {}) {
  async function getNetworkSettings(): Promise<NetworkSettings> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('network settings: config.json missing');
    return toNetworkSettings(cfg, false, deps);
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

    // Validate TLS can actually be set up BEFORE persisting https.enabled=true. Otherwise the
    // config saves as HTTPS-enabled but the hot-reload apply (and next boot) fails to make a
    // cert, leaving the daemon in a broken/fail-closed state with no rollback.
    if (req.https?.enabled === true) {
      try {
        await resolveTlsSetupForNetwork({ https: cfg.network.https, tlsDir: paths.tls });
      } catch (err) {
        throw new HandlerError('invalid', `HTTPS unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await saveSystemConfig(paths.config, cfg);
    if (configReloader) {
      const event = { cfg, auth: await loadAuth(paths.auth) };
      setTimeout(() => void configReloader.publish(event), 25);
    }
    return toNetworkSettings(cfg, !configReloader, deps);
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
