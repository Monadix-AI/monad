import { expect, test } from 'bun:test';

import { buildDaemonTcpListenOptions } from '@/bootstrap/serve.ts';

test('daemon TCP listener enables HTTP/3 when TLS is configured', () => {
  const options = buildDaemonTcpListenOptions({
    host: '0.0.0.0',
    port: 52749,
    tlsCert: { certPath: '/tmp/monad-cert.pem', keyPath: '/tmp/monad-key.pem' }
  });

  expect(options.http3).toBe(true);
  expect(options.tls).toBeDefined();
});

test('daemon TCP listener does not enable HTTP/3 without TLS', () => {
  const options = buildDaemonTcpListenOptions({ host: '127.0.0.1', port: 52749 });

  expect('http3' in options).toBe(false);
  expect('tls' in options).toBe(false);
});
