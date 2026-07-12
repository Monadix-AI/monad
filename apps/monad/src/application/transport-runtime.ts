import type { DaemonCore } from '#/application/core-runtime.ts';
import type { NetworkRuntime } from '#/application/network-runtime.ts';
import type { ConfigReloadTargets } from '#/config/reload-targets.ts';
import type { ServeDeps } from '#/transports/lifecycle.ts';
import type { DaemonShutdownDependencies } from '#/transports/shutdown.ts';

import { serveDaemon } from '#/transports/lifecycle.ts';
import { createDaemonShutdown } from '#/transports/shutdown.ts';

type ManagedServeKey =
  | 'setMoEnabled'
  | 'tlsCert'
  | 'tlsFingerprint'
  | 'resolveTlsSetupForNetwork'
  | 'openaiCompatConfig'
  | 'onNetworkReloadReady'
  | 'onNetworkRuntimeStatusReady'
  | 'onShutdown';

interface LaunchDaemonTransportsOptions extends DaemonShutdownDependencies {
  serveOptions: Omit<ServeDeps, ManagedServeKey>;
  runtime: DaemonCore['runtime'];
  network: Pick<NetworkRuntime, 'tls' | 'resolveTls' | 'getOpenAiCompatConfig' | 'bindStatus'>;
  reloadTargets: Pick<ConfigReloadTargets, 'setNetwork'>;
  serve?: typeof serveDaemon;
}

export async function launchDaemonTransports(options: LaunchDaemonTransportsOptions): Promise<void> {
  const setMoEnabled = async (enabled: boolean): Promise<void> => {
    if (options.runtime.config.get().cfg.mo.enabled === enabled) return;
    await options.runtime.config.updateConfig((current) => ({ ...current, mo: { ...current.mo, enabled } }));
  };
  const tls = options.network.tls();
  const shutdown = createDaemonShutdown(options);

  await (options.serve ?? serveDaemon)({
    ...options.serveOptions,
    setMoEnabled,
    ...(tls.cert ? { tlsCert: tls.cert } : {}),
    ...(tls.fingerprint ? { tlsFingerprint: tls.fingerprint } : {}),
    resolveTlsSetupForNetwork: options.network.resolveTls,
    openaiCompatConfig: options.network.getOpenAiCompatConfig,
    onNetworkReloadReady: (reload) => options.reloadTargets.setNetwork(reload),
    onNetworkRuntimeStatusReady: (status) => options.network.bindStatus(status),
    onShutdown: shutdown
  });
  options.runtime.startWatching();
}
