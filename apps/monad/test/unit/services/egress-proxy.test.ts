import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
  createMitmCA,
  ProtectedResponseBudget,
  SENTINEL_PREFIX,
  SentinelRegistry,
  startEgressProxy,
  startProtectedExecutionProxy
} from '@monad/sandbox';

// Raw sockets throughout: Bun's fetch bypasses the proxy for loopback (NO_PROXY), so it can't
// exercise the proxy against a local origin. Driving the proxy directly is also deterministic.

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const allowAll = { policy: { allowedDomains: ['*'] }, isAllowed: () => true, assertDialable: async () => {} };

/** Connect to `port`, send `firstWrite`, resolve with accumulated bytes once `until` matches. */
function drive(port: number, firstWrite: string, until: (text: string) => boolean): Promise<string> {
  const got: Buffer[] = [];
  return new Promise<string>((resolve, reject) => {
    Bun.connect<undefined>({
      hostname: '127.0.0.1',
      port,
      socket: {
        open: (s) => {
          s.write(firstWrite);
        },
        data: (s, d) => {
          got.push(Buffer.from(d));
          const text = Buffer.concat(got).toString('latin1');
          if (until(text)) {
            resolve(text);
            s.end();
          }
        },
        error: (_s, e) => reject(e)
      }
    }).catch(reject);
  });
}

test('HTTP forward: an allowed request reaches the origin', async () => {
  const origin = Bun.serve({ port: 0, fetch: () => new Response('hello-from-origin') });
  const proxy = startEgressProxy(allowAll);
  cleanups.push(
    () => origin.stop(true),
    () => proxy.stop()
  );

  const text = await drive(
    proxy.port,
    `GET http://127.0.0.1:${origin.port}/x HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
    (t) => t.includes('hello-from-origin')
  );
  expect(text).toContain('hello-from-origin');
});

test('HTTP forward: a denied host gets 403 and never reaches the origin', async () => {
  let hits = 0;
  const origin = Bun.serve({
    port: 0,
    fetch: () => {
      hits++;
      return new Response('should-not-be-reached');
    }
  });
  const proxy = startEgressProxy({ policy: { allowedDomains: [] }, isAllowed: () => false });
  cleanups.push(
    () => origin.stop(true),
    () => proxy.stop()
  );

  const text = await drive(
    proxy.port,
    `GET http://127.0.0.1:${origin.port}/x HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
    (t) => t.includes('\r\n\r\n')
  );
  expect(text).toContain('403 Forbidden');
  expect(hits).toBe(0);
});

test('protected absolute-form HTTP rewrites the canonical request and redacts the fully buffered response', async () => {
  const secret = 'plain-http-secret-canary';
  const registry = new SentinelRegistry();
  const sentinel = registry.register('TOKEN', secret, ['127.0.0.1']);
  let observed = {};
  const origin = Bun.serve({
    port: 0,
    async fetch(request) {
      observed = {
        url: new URL(request.url).pathname + new URL(request.url).search,
        authorization: request.headers.get('authorization'),
        acceptEncoding: request.headers.get('accept-encoding'),
        body: await request.text()
      };
      return new Response(`body:${secret}:${secret}`, {
        headers: { 'content-type': 'text/plain', 'x-reflected-credential': secret }
      });
    }
  });
  const failures: string[] = [];
  const proxy = startEgressProxy({
    ...allowAll,
    rewriteRequest: (host, block) => registry.substitute(host, block),
    rewriteBody: (host, body) => registry.substitute(host, body),
    responseRedactions: () => registry.redactionsForResponse(),
    protectedResponseBudget: new ProtectedResponseBudget(),
    disableSocks: true,
    onProtectedTransportFailure: (code) => failures.push(code)
  });
  cleanups.push(
    () => origin.stop(true),
    () => proxy.stop()
  );

  const body = JSON.stringify({ token: sentinel });
  const text = await drive(
    proxy.port,
    `POST http://127.0.0.1:${origin.port}/reflect?token=${sentinel} HTTP/1.1\r\n` +
      `Host: spoofed.example\r\nAuthorization: Bearer ${sentinel}\r\nAccept-Encoding: gzip\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    (response) => response.includes(`body:${sentinel}:${sentinel}`)
  );
  expect(observed).toEqual({
    url: '/reflect?token=plain-http-secret-canary',
    authorization: 'Bearer plain-http-secret-canary',
    acceptEncoding: 'identity',
    body: JSON.stringify({ token: 'plain-http-secret-canary' })
  });
  expect(text.toLowerCase()).toContain(`x-reflected-credential: ${sentinel}`);
  expect(text).not.toContain(secret);
  expect(failures).toEqual([]);
});

test('protected proxy rejects a deliberate SOCKS greeting before any raw tunnel is available', async () => {
  const failures: string[] = [];
  const proxy = startEgressProxy({
    ...allowAll,
    disableSocks: true,
    onProtectedTransportFailure: (code) => failures.push(code)
  });
  cleanups.push(() => proxy.stop());
  const reply = await new Promise<number[]>((resolve, reject) => {
    void Bun.connect({
      hostname: '127.0.0.1',
      port: proxy.port,
      socket: {
        open(socket) {
          socket.write(Buffer.from([0x05, 0x01, 0x00]));
        },
        data(socket, data) {
          resolve([...data]);
          socket.end();
        },
        error(_socket, error) {
          reject(error);
        }
      }
    });
  });
  expect({ reply, failures }).toEqual({
    reply: [0x05, 0xff],
    failures: ['protected_transport_unsupported']
  });
});

test('close shares one promise and waits for an active protected response to release its budget', async () => {
  const registry = new SentinelRegistry();
  registry.register('TOKEN', 'held-http-secret', ['127.0.0.1']);
  let responseStartedResolve: (() => void) | undefined;
  const responseStarted = new Promise<void>((resolve) => {
    responseStartedResolve = resolve;
  });
  const origin = Bun.serve({
    port: 0,
    fetch() {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('held'));
          responseStartedResolve?.();
        }
      });
      return new Response(body, { headers: { 'content-type': 'text/plain' } });
    }
  });
  const budget = new ProtectedResponseBudget();
  const proxy = startEgressProxy({
    ...allowAll,
    responseRedactions: () => registry.redactionsForResponse(),
    protectedResponseBudget: budget
  });
  cleanups.push(
    () => origin.stop(true),
    () => proxy.stop()
  );
  const clientClosed = new Promise<void>((resolve, reject) => {
    void Bun.connect({
      hostname: '127.0.0.1',
      port: proxy.port,
      socket: {
        open(socket) {
          socket.write(
            `GET http://127.0.0.1:${origin.port}/held HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`
          );
        },
        data() {},
        close() {
          resolve();
        },
        error(_socket, error) {
          reject(error);
        }
      }
    });
  });

  await responseStarted;
  for (let attempts = 0; budget.reservedBytes === 0 && attempts < 100; attempts++) await Bun.sleep(1);
  const reservedBeforeClose = budget.reservedBytes;
  const firstClose = proxy.close();
  const secondClose = proxy.close();
  await Promise.all([firstClose, clientClosed]);
  expect({
    sharedPromise: firstClose === secondClose,
    reservedBeforeClose: reservedBeforeClose > 0,
    reservedAfterClose: budget.reservedBytes
  }).toEqual({ sharedPromise: true, reservedBeforeClose: true, reservedAfterClose: 0 });
});

test('protected close cancels and drains a pre-handle route before CA and registry cleanup', async () => {
  const ca = createMitmCA();
  const caPath = ca.caCertPath;
  const originalLeafForHost = ca.leafForHost.bind(ca);
  let leafAllocations = 0;
  Object.defineProperty(ca, 'leafForHost', {
    value(host: string) {
      leafAllocations++;
      return originalLeafForHost(host);
    }
  });
  let clearCalls = 0;
  const registry = new (class extends SentinelRegistry {
    override clear(): void {
      clearCalls++;
      super.clear();
    }
  })();
  let dialEnteredResolve: (() => void) | undefined;
  const dialEntered = new Promise<void>((resolve) => {
    dialEnteredResolve = resolve;
  });
  let cancellationResolve: (() => void) | undefined;
  const cancellation = new Promise<void>((resolve) => {
    cancellationResolve = resolve;
  });
  let releaseDial: (() => void) | undefined;
  const protectedProxy = startProtectedExecutionProxy(
    [{ environmentVariable: 'TOKEN', secret: 'route-close-secret', allowedHosts: ['a.example'] }],
    {
      caFactory: () => ca,
      registryFactory: () => registry,
      assertDialable: (_host, signal) =>
        new Promise<void>((resolve) => {
          releaseDial = resolve;
          signal?.addEventListener('abort', () => cancellationResolve?.(), { once: true });
          dialEnteredResolve?.();
        }),
      dialTimeoutMs: 1000
    }
  );
  cleanups.push(() => void protectedProxy.close());
  void Bun.connect({
    hostname: '127.0.0.1',
    port: protectedProxy.port,
    socket: {
      open(socket) {
        socket.write('CONNECT a.example:443 HTTP/1.1\r\nHost: a.example\r\n\r\n');
      },
      data() {},
      error() {}
    }
  });

  await dialEntered;
  let closeSettled = false;
  const closePromise = protectedProxy.close().then(() => {
    closeSettled = true;
  });
  await cancellation;
  await Bun.sleep(10);
  expect({
    closeSettled,
    caExists: existsSync(caPath),
    clearCalls,
    leafAllocations
  }).toEqual({ closeSettled: false, caExists: true, clearCalls: 0, leafAllocations: 0 });

  releaseDial?.();
  await closePromise;
  await Bun.sleep(10);
  expect({
    closeSettled,
    caExists: existsSync(caPath),
    clearCalls,
    leafAllocations
  }).toEqual({ closeSettled: true, caExists: false, clearCalls: 1, leafAllocations: 0 });
});

test('a never-settling dialability check fails within the configured route timeout', async () => {
  let dialStarted = false;
  const proxy = startEgressProxy({
    ...allowAll,
    assertDialable: () => {
      dialStarted = true;
      return new Promise<void>(() => {});
    },
    dialTimeoutMs: 20
  });
  cleanups.push(() => proxy.stop());
  const text = await drive(
    proxy.port,
    'GET http://never.example/x HTTP/1.1\r\nHost: never.example\r\nConnection: close\r\n\r\n',
    (response) => response.includes('\r\n\r\n')
  );
  expect({ dialStarted, denied: text.includes('403 Forbidden') }).toEqual({ dialStarted: true, denied: true });
});

test('close cancels a pending raw upstream connect and ignores its late resolution', async () => {
  let connectStartedResolve: (() => void) | undefined;
  const connectStarted = new Promise<void>((resolve) => {
    connectStartedResolve = resolve;
  });
  let resolveConnected: (() => void) | undefined;
  const connected = new Promise<void>((resolve) => {
    resolveConnected = resolve;
  });
  let cancelCalls = 0;
  let forwardedWrites = 0;
  let retained = true;
  const logs: string[] = [];
  const proxy = startEgressProxy({
    ...allowAll,
    connectTimeoutMs: 1000,
    connectRaw: () => {
      connectStartedResolve?.();
      return {
        connected,
        write() {
          forwardedWrites++;
        },
        end() {},
        cancel() {
          cancelCalls++;
          retained = false;
        }
      };
    },
    log: (message) => logs.push(message)
  });
  cleanups.push(() => proxy.stop());
  void Bun.connect({
    hostname: '127.0.0.1',
    port: proxy.port,
    socket: {
      open(socket) {
        socket.write(
          'GET http://late-connect-secret.example/x HTTP/1.1\r\nHost: late-connect-secret.example\r\nConnection: close\r\n\r\n'
        );
      },
      data() {},
      error() {}
    }
  });

  await connectStarted;
  const closeResult = await Promise.race([proxy.close().then(() => 'closed'), Bun.sleep(200).then(() => 'timed_out')]);
  resolveConnected?.();
  await Bun.sleep(10);
  expect({ closeResult, cancelCalls, forwardedWrites, retained, logs }).toEqual({
    closeResult: 'closed',
    cancelCalls: 1,
    forwardedWrites: 0,
    retained: false,
    logs: []
  });
});

test('a never-settling raw upstream connect is cancelled at its independent timeout', async () => {
  let cancelCalls = 0;
  let forwardedWrites = 0;
  const logs: string[] = [];
  const proxy = startEgressProxy({
    ...allowAll,
    connectTimeoutMs: 20,
    connectRaw: () => ({
      connected: new Promise<void>(() => {}),
      write() {
        forwardedWrites++;
      },
      end() {},
      cancel() {
        cancelCalls++;
      }
    }),
    log: (message) => logs.push(message)
  });
  cleanups.push(() => proxy.stop());
  const text = await drive(
    proxy.port,
    'GET http://connect-timeout-secret.example/x HTTP/1.1\r\nHost: connect-timeout-secret.example\r\nConnection: close\r\n\r\n',
    (response) => response.includes('\r\n\r\n')
  );
  expect({ denied: text.includes('502 Bad Gateway'), cancelCalls, forwardedWrites, logs }).toEqual({
    denied: true,
    cancelCalls: 1,
    forwardedWrites: 0,
    logs: []
  });
});

test('CONNECT: an allowed authority tunnels bytes end to end', async () => {
  const echo = Bun.listen<undefined>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data: (s, d) => {
        s.write(d);
      },
      open: () => {}
    }
  });
  const proxy = startEgressProxy(allowAll);
  cleanups.push(
    () => echo.stop(true),
    () => proxy.stop()
  );

  const got: Buffer[] = [];
  const result = await new Promise<string>((resolve, reject) => {
    Bun.connect<undefined>({
      hostname: '127.0.0.1',
      port: proxy.port,
      socket: {
        open: (s) => {
          s.write(`CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: x\r\n\r\n`);
        },
        data: (s, d) => {
          got.push(Buffer.from(d));
          const text = Buffer.concat(got).toString('latin1');
          if (text.includes('200 Connection Established') && !text.includes('PONG')) s.write('PONG');
          if (text.includes('PONG')) {
            resolve(text);
            s.end();
          }
        },
        error: (_s, e) => reject(e)
      }
    }).catch(reject);
  });
  expect(result).toContain('200 Connection Established');
  expect(result).toContain('PONG'); // bytes round-tripped through the tunnel
});

test('CONNECT: a denied authority gets 403 and no tunnel', async () => {
  const proxy = startEgressProxy({ policy: { allowedDomains: [] }, isAllowed: () => false });
  cleanups.push(() => proxy.stop());

  const text = await drive(proxy.port, 'CONNECT blocked.example:443 HTTP/1.1\r\nHost: blocked.example\r\n\r\n', (t) =>
    t.includes('\r\n\r\n')
  );
  expect(text).toContain('403 Forbidden');
});

test('protected executions isolate fresh child sentinels from proxy configuration and logs', async () => {
  const canaryA = 'credential-canary-a';
  const canaryB = 'credential-canary-b';
  const logs: string[] = [];
  const credentials = [
    { environmentVariable: 'A_TOKEN', secret: canaryA, allowedHosts: ['a.example'] },
    { environmentVariable: 'B_TOKEN', secret: canaryB, allowedHosts: ['b.example'] }
  ];
  const first = startProtectedExecutionProxy(credentials, { log: (message) => logs.push(message) });
  const second = startProtectedExecutionProxy(credentials);
  const caPaths = [first.proxyEnv.NODE_EXTRA_CA_CERTS ?? '', second.proxyEnv.NODE_EXTRA_CA_CERTS ?? ''];
  try {
    expect(Object.keys(first.childEnv).sort()).toEqual(['A_TOKEN', 'B_TOKEN']);
    expect(Object.values(first.childEnv).every((value) => value.startsWith(SENTINEL_PREFIX))).toBe(true);
    expect(first.childEnv.A_TOKEN).not.toBe(second.childEnv.A_TOKEN);
    expect(first.childEnv.B_TOKEN).not.toBe(second.childEnv.B_TOKEN);
    expect(Object.keys(first.proxyEnv).sort()).toEqual([
      'ALL_PROXY',
      'CURL_CA_BUNDLE',
      'DENO_CERT',
      'GIT_SSL_CAINFO',
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'NODE_EXTRA_CA_CERTS',
      'NO_PROXY',
      'PIP_CERT',
      'REQUESTS_CA_BUNDLE',
      'SSL_CERT_FILE',
      'all_proxy',
      'http_proxy',
      'https_proxy',
      'no_proxy',
      'npm_config_cafile'
    ]);
    expect(`${JSON.stringify(first.childEnv)}${JSON.stringify(first.proxyEnv)}`).not.toContain(canaryA);
    expect(`${JSON.stringify(first.childEnv)}${JSON.stringify(first.proxyEnv)}`).not.toContain(canaryB);
    expect(logs).toEqual(['protected_execution_proxy_started credential_count=2']);
    expect(logs.join('')).not.toContain(canaryA);
    expect(logs.join('')).not.toContain(canaryB);
    expect(logs.join('')).not.toContain(SENTINEL_PREFIX);
    expect(logs.join('')).not.toContain('/monad-');
    expect(logs.join('')).not.toContain(first.childEnv.A_TOKEN ?? '');
    const firstClose = first.close();
    const secondClose = first.close();
    expect(firstClose).toBe(secondClose);
    await firstClose;
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
  expect(caPaths.map((path) => existsSync(path))).toEqual([false, false]);
});

test.each(['before_directory', 'after_directory', 'before_cert_write', 'before_key_write'] as const)(
  'protected proxy maps CA startup failure at %s to one stable public error',
  (testFailureStage) => {
    let message = '';
    try {
      startProtectedExecutionProxy(
        [{ environmentVariable: 'TOKEN', secret: 'credential-canary', allowedHosts: ['a.example'] }],
        { caFactory: () => createMitmCA({ testFailureStage }) }
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('protected_execution_proxy_start_failed');
    expect(message).not.toContain('/');
    expect(message).not.toContain('credential-canary');
  }
);
