import { afterAll, beforeAll, expect, test } from 'bun:test';

import { proxyResponseBody } from '@/lib/proxy-stream';
import { startWeb } from '../../server/index.ts';

// The web server serves the embedded SPA and proxies /api/* to the daemon (replacing
// the old Next route handler). Exercise the proxy against a fake provider.

let provider: ReturnType<typeof Bun.serve>;
let web: ReturnType<typeof startWeb>;

beforeAll(() => {
  provider = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === '/health') return Response.json({ status: 'ok' });
      if (pathname === '/v1/echo') return new Response(req.method);
      return new Response('nope', { status: 404 });
    }
  });
  Bun.env.WEB_PORT = '0';
  web = startWeb({ daemonUrl: `http://127.0.0.1:${provider.port}` });
});

afterAll(() => {
  web.stop(true);
  provider.stop(true);
  delete Bun.env.WEB_PORT;
});

test('startWeb returns a running server', () => {
  expect(typeof startWeb).toBe('function');
  expect(web.port).toBeGreaterThan(0);
});

test('proxies /api/* to the daemon', async () => {
  const res = await fetch(`http://127.0.0.1:${web.port}/api/health`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { status: string }).status).toBe('ok');
});

test('proxy forwards the request method', async () => {
  const res = await fetch(`http://127.0.0.1:${web.port}/api/v1/echo`, { method: 'POST', body: 'x' });
  expect(await res.text()).toBe('POST');
});

test('proxyResponseBody turns late SSE read errors into a clean close', async () => {
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      pulls += 1;
      if (pulls === 1) {
        ctrl.enqueue(new TextEncoder().encode('event: ready\ndata: {"ok":true}\n\n'));
        return;
      }
      ctrl.error(new Error('socket reset'));
    }
  });
  const wrapped = proxyResponseBody(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));

  await expect(new Response(wrapped).text()).resolves.toContain('event: ready');
});

test('next.config exports an object', async () => {
  const mod = await import('../../next.config.ts');
  expect(typeof mod.default).toBe('object');
});

// ── readDaemonUrl path resolution ─────────────────────────────────────────────
// readDaemonUrl() is private; test it by writing a port into MONAD_HOME/configs/config.json
// and verifying startWeb() auto-proxies to that port without an explicit daemonUrl.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('readDaemonUrl reads port from MONAD_HOME/configs/config.json', async () => {
  const home = join(tmpdir(), `monad-web-cfgpath-${Date.now()}`);
  mkdirSync(join(home, 'configs'), { recursive: true });

  // Fake daemon returns a sentinel status so we can confirm the proxy reached it.
  const fake = Bun.serve({
    port: 0,
    fetch: () => new Response('hit', { status: 418, headers: { 'x-hit': '1' } })
  });
  writeFileSync(join(home, 'configs', 'config.json'), JSON.stringify({ network: { port: fake.port } }));

  const prevHome = Bun.env.MONAD_HOME;
  Bun.env.MONAD_HOME = home;
  Bun.env.WEB_PORT = '0';
  const ws = startWeb();

  try {
    const res = await fetch(`http://127.0.0.1:${ws.port}/api/probe`);
    // 418 from the fake daemon confirms the proxy reached the right port.
    expect(res.status).toBe(418);
    expect(res.headers.get('x-hit')).toBe('1');
  } finally {
    ws.stop(true);
    fake.stop(true);
    Bun.env.MONAD_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('readDaemonUrl ignores config.json at home root — must be under configs/', async () => {
  // Regression: old code read MONAD_HOME/config.json; fixed code reads MONAD_HOME/configs/config.json.
  const home = join(tmpdir(), `monad-web-wrongpath-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  // Write only at the wrong location (root), not in configs/.
  const sentinelStatus = 418;
  writeFileSync(join(home, 'config.json'), JSON.stringify({ network: { port: 19998 } }));

  const prevHome = Bun.env.MONAD_HOME;
  Bun.env.MONAD_HOME = home;
  Bun.env.WEB_PORT = '0';
  const ws = startWeb();

  try {
    expect(ws.port).toBeGreaterThan(0);
    // Proxy falls back to 52749 (nothing running) — status must NOT be the sentinel.
    const res = await fetch(`http://127.0.0.1:${ws.port}/api/probe`).catch(() => null);
    if (res) expect(res.status).not.toBe(sentinelStatus);
  } finally {
    ws.stop(true);
    Bun.env.MONAD_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});
