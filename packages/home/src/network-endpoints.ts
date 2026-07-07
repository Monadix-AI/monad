import type { MonadConfig } from './config/index.ts';

export const DEFAULT_DAEMON_HOST = '127.0.0.1';
export const DEFAULT_REMOTE_DAEMON_HOST = '0.0.0.0';
export const DEFAULT_DAEMON_PORT = 52749;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

type NetworkConfig = MonadConfig['network'];
type NetworkEnv = Record<string, string | undefined> & {
  MONAD_HOST?: string;
  MONAD_PORT?: string;
  MONAD_HTTP_PORT?: string;
  MONAD_URL?: string;
};

export interface DaemonNetworkResolution {
  bindHost: string;
  connectHost: string;
  port: number;
  scheme: 'https' | 'http';
  primaryUrl: string;
  localUrl: string;
  localHttpFallback?: {
    port: number;
    url: string;
  };
  unixUrl: string;
}

function numberFromEnv(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function loopbackForBindHost(host: string): string {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '::1';
  return host;
}

function hostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export function isLoopbackDaemonHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(normalized)) return true;
  return normalized.startsWith('127.');
}

export function validateDaemonNetworkSecurity(opts: {
  host: string;
  https?: Partial<NetworkConfig['https']> | null;
  remoteAccess?: Partial<NetworkConfig['remoteAccess']> | null;
}): void {
  const remoteEnabled = opts.remoteAccess?.enabled === true;
  if (!remoteEnabled && !isLoopbackDaemonHost(opts.host)) {
    throw new Error('network.host must be loopback unless network.remoteAccess.enabled=true');
  }
  if (remoteEnabled && opts.https?.enabled === false) {
    throw new Error('network.https.enabled=false is only allowed when network.remoteAccess.enabled=false');
  }
}

export function resolveDaemonNetwork(opts: {
  network?: Partial<NetworkConfig> | null;
  env?: NetworkEnv;
}): DaemonNetworkResolution {
  const network = opts.network;
  const remoteEnabled = network?.remoteAccess?.enabled === true;
  const configuredHost = typeof network?.host === 'string' && network.host.trim() ? network.host.trim() : undefined;
  const envHost = opts.env?.MONAD_HOST?.trim();
  const configHost = configuredHost || DEFAULT_DAEMON_HOST;
  const bindHost =
    envHost || (remoteEnabled && configHost === DEFAULT_DAEMON_HOST ? DEFAULT_REMOTE_DAEMON_HOST : configHost);
  validateDaemonNetworkSecurity({ host: bindHost, https: network?.https, remoteAccess: network?.remoteAccess });
  const connectHost = loopbackForBindHost(bindHost);
  const port = numberFromEnv(opts.env?.MONAD_PORT) ?? network?.port ?? DEFAULT_DAEMON_PORT;
  const scheme = network?.https?.enabled === false ? 'http' : 'https';
  const fallbackPort = numberFromEnv(opts.env?.MONAD_HTTP_PORT) ?? network?.localHttpFallback?.port;
  const fallbackEnabled = network?.localHttpFallback?.enabled === true && !!fallbackPort;
  return {
    bindHost,
    connectHost,
    port,
    scheme,
    primaryUrl: `${scheme}://${hostForUrl(bindHost)}:${port}`,
    localUrl: `${scheme}://${hostForUrl(connectHost)}:${port}`,
    ...(fallbackEnabled
      ? {
          localHttpFallback: {
            port: fallbackPort,
            url: `http://${DEFAULT_DAEMON_HOST}:${fallbackPort}`
          }
        }
      : {}),
    unixUrl: 'http://localhost'
  };
}

export function resolveDaemonUrl(opts: { network?: Partial<NetworkConfig> | null; env?: NetworkEnv }): string {
  if (opts.env?.MONAD_URL) return opts.env.MONAD_URL;
  return resolveDaemonNetwork(opts).localUrl;
}
