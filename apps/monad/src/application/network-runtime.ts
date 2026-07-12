import type { MonadConfig } from '@monad/home';
import type { NetworkRuntimeStatus } from '@monad/protocol';
import type { TlsSetup } from '#/transports/tls.ts';

import { loadAll, resolveDaemonNetwork } from '@monad/home';

import { resolveTlsSetupForNetwork } from '#/transports/tls.ts';

interface NetworkRuntimeOptions {
  network: MonadConfig['network'];
  initialOpenAiCompat: Pick<MonadConfig['openaiCompat'], 'enabled' | 'token'>;
  paths: { config: string; profile: string; tls: string };
  env: Record<string, string | undefined>;
  now?: () => number;
  loadConfig?: () => Promise<{ openaiCompat?: Pick<MonadConfig['openaiCompat'], 'enabled' | 'token'> } | null>;
  resolveTls?: (options: {
    https: MonadConfig['network']['https'];
    tlsDir: string;
    current?: TlsSetup;
  }) => Promise<TlsSetup>;
}

export interface NetworkRuntime {
  endpoint: ReturnType<typeof resolveDaemonNetwork>;
  remoteAccess: MonadConfig['network']['remoteAccess'];
  getOpenAiCompatConfig(): Promise<{ enabled: boolean; token?: string }>;
  tls(): TlsSetup;
  resolveTls(https: MonadConfig['network']['https']): Promise<TlsSetup>;
  bindStatus(read: () => NetworkRuntimeStatus | undefined): void;
  status(): NetworkRuntimeStatus | undefined;
}

export async function createNetworkRuntime(_options: NetworkRuntimeOptions): Promise<NetworkRuntime> {
  const options = _options;
  const now = options.now ?? Date.now;
  const loadConfig =
    options.loadConfig ?? (() => loadAll(options.paths.config, options.paths.profile) as ReturnType<typeof loadAll>);
  const resolveTls = options.resolveTls ?? resolveTlsSetupForNetwork;
  const endpoint = resolveDaemonNetwork({ network: options.network, env: options.env });
  let tls = await resolveTls({ https: options.network.https, tlsDir: options.paths.tls });
  let compatCache: { value: { enabled: boolean; token?: string }; expiresAt: number } | undefined;
  let readStatus: () => NetworkRuntimeStatus | undefined = () => undefined;

  return {
    endpoint,
    remoteAccess: options.network.remoteAccess,
    async getOpenAiCompatConfig() {
      if (compatCache && now() < compatCache.expiresAt) return compatCache.value;
      const config = await loadConfig();
      const live = config?.openaiCompat ?? options.initialOpenAiCompat;
      const value = live.token ? { enabled: live.enabled, token: live.token } : { enabled: live.enabled };
      compatCache = { value, expiresAt: now() + 1_000 };
      return value;
    },
    tls: () => tls,
    async resolveTls(https) {
      tls = await resolveTls({ https, tlsDir: options.paths.tls, current: tls });
      return tls;
    },
    bindStatus(read) {
      readStatus = read;
    },
    status: () => readStatus()
  };
}
