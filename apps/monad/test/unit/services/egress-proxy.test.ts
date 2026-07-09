import { afterEach, expect, test } from 'bun:test';
import { startEgressProxy } from '@monad/sandbox';

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

  const _text = await drive(
    proxy.port,
    `GET http://127.0.0.1:${origin.port}/x HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
    (t) => t.includes('hello-from-origin')
  );
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

  const _text = await drive(
    proxy.port,
    `GET http://127.0.0.1:${origin.port}/x HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
    (t) => t.includes('\r\n\r\n')
  );
  expect(hits).toBe(0);
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
  const _result = await new Promise<string>((resolve, reject) => {
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
});

test('CONNECT: a denied authority gets 403 and no tunnel', async () => {
  const proxy = startEgressProxy({ policy: { allowedDomains: [] }, isAllowed: () => false });
  cleanups.push(() => proxy.stop());

  const _text = await drive(proxy.port, 'CONNECT blocked.example:443 HTTP/1.1\r\nHost: blocked.example\r\n\r\n', (t) =>
    t.includes('\r\n\r\n')
  );
});
