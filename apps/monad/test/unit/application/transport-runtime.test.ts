import { expect, test } from 'bun:test';

import { launchDaemonTransports } from '#/application/transport-runtime.ts';

test('transport runtime owns mutable listener bindings and starts config watching after listen', async () => {
  const events: string[] = [];
  let enabled = true;
  const reload = async () => {};
  const status = () => ({ listeners: [], remoteAccess: { enabled: false, tokenRevision: 0 } });

  await launchDaemonTransports({
    serveOptions: {} as never,
    runtime: {
      config: {
        get: () => ({ cfg: { mo: { enabled, binaryPath: '/mo' } } }),
        updateConfig: async (update: (config: MonadConfig) => MonadConfig) => {
          const current = { mo: { enabled, binaryPath: '/mo' } };
          enabled = update(current as MonadConfig).mo.enabled;
          events.push(`mo:${enabled}`);
        }
      },
      startWatching: () => events.push('watching'),
      stop: async () => void events.push('runtime:stop')
    } as never,
    network: {
      tls: () => ({ cert: { certPath: '/tls/cert', keyPath: '/tls/key' }, fingerprint: 'sha256', warnings: [] }),
      resolveTls: async () => ({ warnings: [] }),
      getOpenAiCompatConfig: async () => ({ enabled: false }),
      bindStatus: (read: () => NetworkRuntimeStatus | undefined) => {
        expect(read()).toEqual(status());
        events.push('status:bound');
      }
    } as never,
    reloadTargets: { setNetwork: (next) => void events.push(next === reload ? 'reload:bound' : 'reload:wrong') },
    schedule: { dispose: () => events.push('schedule:dispose') },
    watchers: { closeAll: () => events.push('watchers:close') },
    channels: { stop: async () => void events.push('channels:stop') },
    meshAgents: { stopAll: () => events.push('meshAgents:stop') },
    serve: async (options) => {
      expect([options.tlsCert, options.tlsFingerprint]).toEqual([
        { certPath: '/tls/cert', keyPath: '/tls/key' },
        'sha256'
      ]);
      await options.setMoEnabled(false);
      options.onNetworkReloadReady?.(reload);
      options.onNetworkRuntimeStatusReady?.(status);
      await options.onShutdown?.();
      events.push('served');
    }
  });

  expect(events).toEqual([
    'mo:false',
    'reload:bound',
    'status:bound',
    'schedule:dispose',
    'watchers:close',
    'channels:stop',
    'meshAgents:stop',
    'runtime:stop',
    'served',
    'watching'
  ]);
});

import type { MonadConfig } from '@monad/environment';
import type { NetworkRuntimeStatus } from '@monad/protocol';
