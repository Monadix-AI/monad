import type { MonadConfig } from '@monad/environment';
import type { NetworkRuntimeStatus } from '@monad/protocol';
import type { TlsSetup } from '#/transports/tls.ts';

import { expect, test } from 'bun:test';

import { createNetworkRuntime } from '#/application/network-runtime.ts';

const httpsEnabled: MonadConfig['network']['https'] = { enabled: true };
const httpsDisabled: MonadConfig['network']['https'] = { enabled: false };

test('network runtime keeps live compatibility config and TLS state behind stable readers', async () => {
  let now = 1_000;
  let configReads = 0;
  const tlsCalls: Array<{ https: MonadConfig['network']['https']; current?: TlsSetup }> = [];
  const initialTls: TlsSetup = {
    cert: { certPath: '/tls/initial.crt', keyPath: '/tls/initial.key' },
    fingerprint: 'initial',
    expiry: '2030-01-01T00:00:00.000Z',
    warnings: []
  };
  const disabledTls: TlsSetup = { warnings: ['tls:https-disabled'] };
  const runtime = await createNetworkRuntime({
    network: {
      remoteAccess: { enabled: false },
      https: httpsEnabled
    } as MonadConfig['network'],
    initialOpenAiCompat: { enabled: false },
    paths: {
      config: '/home/config.json',
      agentsConfig: '/home/agents.json',
      mesh: '/home/mesh.json',
      tls: '/home/tls'
    },
    env: {},
    now: () => now,
    loadConfig: async () => {
      configReads += 1;
      return { openaiCompat: { enabled: true, token: `token-${configReads}` } };
    },
    resolveTls: async ({ https, current }) => {
      tlsCalls.push({ https, current });
      return https.enabled ? initialTls : disabledTls;
    }
  });

  expect(await runtime.getOpenAiCompatConfig()).toEqual({ enabled: true, token: 'token-1' });
  expect(await runtime.getOpenAiCompatConfig()).toEqual({ enabled: true, token: 'token-1' });
  now += 1_001;
  expect(await runtime.getOpenAiCompatConfig()).toEqual({ enabled: true, token: 'token-2' });

  expect(runtime.tls()).toEqual(initialTls);
  expect(await runtime.resolveTls(httpsDisabled)).toEqual(disabledTls);
  expect(tlsCalls).toEqual([
    { https: httpsEnabled, current: undefined },
    { https: httpsDisabled, current: initialTls }
  ]);

  const status: NetworkRuntimeStatus = { listeners: [], remoteAccess: { enabled: false, tokenRevision: 0 } };
  runtime.bindStatus(() => status);
  expect(runtime.status()).toEqual(status);
});
