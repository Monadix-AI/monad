import { expect, test } from 'bun:test';

import {
  buildDaemonTcpListenOptions,
  createDaemonTcpRuntime,
  daemonLoopbackUrl,
  daemonWebUiUrl,
  formatHttpsDisabledWarnings,
  planTcpListeners,
  resolveServeDeveloperMode,
  shouldEnableDeveloperDocs
} from '#/transports/lifecycle.ts';

test('planTcpListeners uses HTTPS on the primary port by default', () => {
  expect(
    planTcpListeners({
      host: '127.0.0.1',
      https: { enabled: true },
      remoteAccess: { enabled: false, token: null },
      port: 52749,
      localHttpFallback: { enabled: false, port: 52780 }
    })
  ).toEqual([{ scheme: 'https', host: '127.0.0.1', port: 52749 }]);
});

test('HTTPS listener enables HTTP/3 over QUIC on the same port', () => {
  const options = buildDaemonTcpListenOptions({
    host: '127.0.0.1',
    port: 52749,
    tlsCert: { certPath: '/tmp/cert.pem', keyPath: '/tmp/key.pem' }
  });

  expect(options).toMatchObject({
    hostname: '127.0.0.1',
    port: 52749,
    http3: true,
    tls: {
      cert: expect.any(Blob),
      key: expect.any(Blob)
    }
  });
});

test('plain HTTP listeners do not enable HTTP/3', () => {
  expect(buildDaemonTcpListenOptions({ host: '127.0.0.1', port: 52780 })).toEqual({
    hostname: '127.0.0.1',
    port: 52780,
    maxRequestBodySize: 4 * 1024 * 1024
  });
});

test('planTcpListeners adds local-only HTTP fallback when enabled', () => {
  expect(
    planTcpListeners({
      host: '127.0.0.1',
      https: { enabled: true },
      remoteAccess: { enabled: false, token: null },
      port: 52749,
      localHttpFallback: { enabled: true, port: 52780 }
    })
  ).toEqual([
    { scheme: 'https', host: '127.0.0.1', port: 52749 },
    { scheme: 'http', host: '127.0.0.1', port: 52780 }
  ]);
});

test('planTcpListeners keeps HTTP fallback loopback-only when remote access binds the primary listener', () => {
  expect(
    planTcpListeners({
      host: '0.0.0.0',
      https: { enabled: true },
      remoteAccess: { enabled: true, token: 'token' },
      port: 52749,
      localHttpFallback: { enabled: true, port: 52780 }
    })
  ).toEqual([
    { scheme: 'https', host: '0.0.0.0', port: 52749 },
    { scheme: 'http', host: '127.0.0.1', port: 52780 }
  ]);
});

test('planTcpListeners turns the primary listener into HTTP when HTTPS is disabled', () => {
  expect(
    planTcpListeners({
      host: '127.0.0.1',
      https: { enabled: false },
      remoteAccess: { enabled: false, token: null },
      port: 52749,
      localHttpFallback: { enabled: false, port: 52780 }
    })
  ).toEqual([{ scheme: 'http', host: '127.0.0.1', port: 52749 }]);
});

test('planTcpListeners rejects remote access over HTTP when the emergency HTTPS switch is disabled', () => {
  expect(() =>
    planTcpListeners({
      host: '0.0.0.0',
      https: { enabled: false },
      remoteAccess: { enabled: true, token: 'token' },
      port: 52749,
      localHttpFallback: { enabled: true, port: 52780 }
    })
  ).toThrow(/network\.https\.enabled=false/);
});

test('planTcpListeners rejects non-loopback primary hosts without remote access', () => {
  expect(() =>
    planTcpListeners({
      host: '0.0.0.0',
      https: { enabled: true },
      remoteAccess: { enabled: false, token: null },
      port: 52749,
      localHttpFallback: { enabled: true, port: 52780 }
    })
  ).toThrow(/network\.host must be loopback/);
});

test('formatHttpsDisabledWarnings calls out remote access when HTTP is exposed beyond loopback', () => {
  expect(formatHttpsDisabledWarnings({ remoteAccessEnabled: true })).toEqual([
    'WARNING: HTTPS is disabled by network.https.enabled=false. Daemon TCP traffic is plain HTTP.',
    'WARNING: remote access is enabled while HTTPS is disabled. Remote daemon traffic is exposed over plain HTTP.'
  ]);
});

test('daemon TCP runtime reapplies listener plan without a process restart', async () => {
  const stopped: string[] = [];
  const started: string[] = [];
  const runtime = createDaemonTcpRuntime({
    app: {} as never,
    initial: {
      host: '127.0.0.1',
      https: { enabled: false },
      remoteAccess: { enabled: false, token: null },
      port: 52749,
      localHttpFallback: { enabled: false, port: 52780 }
    },
    listenHttp: (_app, listener) => {
      const key = `${listener.scheme}:${listener.host}:${listener.port}`;
      started.push(key);
      return { stop: () => stopped.push(key) };
    },
    listenHttps: (_app, listener) => {
      const key = `${listener.scheme}:${listener.host}:${listener.port}`;
      started.push(key);
      return { stop: () => stopped.push(key) };
    }
  });

  expect(runtime.listeners()).toEqual([{ scheme: 'http', host: '127.0.0.1', port: 52749 }]);

  await runtime.apply({
    host: '0.0.0.0',
    https: { enabled: true },
    remoteAccess: { enabled: true, token: 'secret' },
    port: 52749,
    localHttpFallback: { enabled: true, port: 52780 },
    tlsCert: { certPath: '/tmp/cert.pem', keyPath: '/tmp/key.pem' }
  });

  expect(started).toEqual(['http:127.0.0.1:52749', 'https:0.0.0.0:52749', 'http:127.0.0.1:52780']);
  expect(stopped).toEqual(['http:127.0.0.1:52749']);
  expect(runtime.listeners()).toEqual([
    { scheme: 'https', host: '0.0.0.0', port: 52749 },
    { scheme: 'http', host: '127.0.0.1', port: 52780 }
  ]);

  runtime.stop();
  expect(stopped).toEqual(['http:127.0.0.1:52749', 'https:0.0.0.0:52749', 'http:127.0.0.1:52780']);
});

test('daemon TCP runtime records last apply failures and preserves the previous listener plan', async () => {
  const runtime = createDaemonTcpRuntime({
    app: {} as never,
    initial: {
      host: '127.0.0.1',
      https: { enabled: false },
      remoteAccess: { enabled: false, token: null },
      port: 52749,
      localHttpFallback: { enabled: false, port: 52780 }
    },
    listenHttp: (_app, listener) => {
      if (listener.port === 52780) throw new Error('bind failed');
      return { stop: () => {} };
    },
    listenHttps: () => ({ stop: () => {} })
  });

  await expect(
    runtime.apply({
      host: '0.0.0.0',
      https: { enabled: true },
      remoteAccess: { enabled: true, token: 'secret' },
      port: 52749,
      localHttpFallback: { enabled: true, port: 52780 },
      tlsCert: { certPath: '/tmp/cert.pem', keyPath: '/tmp/key.pem' }
    })
  ).rejects.toThrow(/bind failed/);

  expect(runtime.status().lastError?.message).toBe('bind failed');
  expect(runtime.status().listeners).toEqual([{ scheme: 'http', host: '127.0.0.1', port: 52749 }]);
  runtime.stop();
});

test('daemonLoopbackUrl follows the HTTPS setting for external agent callbacks', () => {
  expect(daemonLoopbackUrl({ https: { enabled: true }, port: 52749 })).toBe('https://127.0.0.1:52749');
  expect(daemonLoopbackUrl({ https: { enabled: false }, port: 52749 })).toBe('http://127.0.0.1:52749');
});

test('daemonWebUiUrl follows HTTPS when advertising the dev web server', () => {
  expect(
    daemonWebUiUrl({
      dev: true,
      host: '127.0.0.1',
      https: { enabled: true },
      port: 52749,
      webPort: '3000'
    })
  ).toBe('https://localhost:3000');
});

test('daemonWebUiUrl keeps the explicit HTTP fallback when HTTPS is disabled', () => {
  expect(
    daemonWebUiUrl({
      dev: true,
      host: '127.0.0.1',
      https: { enabled: false },
      port: 52749,
      webPort: '3000'
    })
  ).toBe('http://localhost:3000');
});

test('daemonWebUiUrl uses localhost for wildcard production binds', () => {
  expect(
    daemonWebUiUrl({
      dev: false,
      host: '0.0.0.0',
      https: { enabled: true },
      port: 52749
    })
  ).toBe('https://localhost:52749/');
});

test('developer docs are controlled by Developer Mode, not the runtime dev flag', () => {
  expect(shouldEnableDeveloperDocs({ developerMode: true, stdoutRpc: false })).toBe(true);
  expect(shouldEnableDeveloperDocs({ developerMode: false, stdoutRpc: false })).toBe(false);
  expect(shouldEnableDeveloperDocs({ developerMode: true, stdoutRpc: true })).toBe(false);
});

test('runtime --dev enables daemon Developer Mode for startup-only developer features', () => {
  expect(resolveServeDeveloperMode({ configured: false, devMode: true, devSilent: false })).toBe(true);
  expect(resolveServeDeveloperMode({ configured: false, devMode: false, devSilent: true })).toBe(true);
  expect(resolveServeDeveloperMode({ configured: true, devMode: false, devSilent: false })).toBe(true);
  expect(resolveServeDeveloperMode({ configured: false, devMode: false, devSilent: false })).toBe(false);
});
