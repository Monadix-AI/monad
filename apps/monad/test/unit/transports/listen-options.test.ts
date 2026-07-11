import { expect, test } from 'bun:test';

import { buildDaemonTcpListenOptions } from '#/transports/lifecycle.ts';

test('daemon TCP listener enables HTTP/3 when TLS is configured', () => {
  const options = buildDaemonTcpListenOptions({
    host: '0.0.0.0',
    port: 52749,
    tlsCert: { certPath: '/tmp/monad-cert.pem', keyPath: '/tmp/monad-key.pem' }
  });

  expect(options).toMatchObject({
    hostname: '0.0.0.0',
    port: 52749,
    http3: true,
    tls: {
      cert: Bun.file('/tmp/monad-cert.pem'),
      key: Bun.file('/tmp/monad-key.pem')
    }
  });
});

test('daemon TCP listener does not enable HTTP/3 without TLS', () => {
  const options = buildDaemonTcpListenOptions({ host: '127.0.0.1', port: 52749 });

  expect(options).toEqual({ hostname: '127.0.0.1', maxRequestBodySize: 4 * 1024 * 1024, port: 52749 });
});
