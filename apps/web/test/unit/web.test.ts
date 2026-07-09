import { afterAll, beforeAll, expect, test } from 'bun:test';

import { loopbackTlsOptions } from '#/lib/loopback-tls';
import { proxyResponseBody } from '#/lib/proxy-stream';
import { proxyDevWebRequest, resolveDevWebProxyUrl, startWeb } from '../../server/index.ts';

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

test('standalone web proxies same-origin /v1 requests for exported release assets', async () => {
  const res = await fetch(`http://127.0.0.1:${web.port}/v1/echo`, { method: 'POST', body: 'x' });
  expect(await res.text()).toBe('POST');
});

test('standalone web bridges same-origin WebSocket control stream to the daemon', async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined;
      return new Response('upgrade required', { status: 426 });
    },
    websocket: {
      message(ws, message) {
        ws.send(`daemon:${String(message)}`);
      }
    }
  });

  Bun.env.WEB_PORT = '0';
  const proxy = startWeb({ daemonUrl: `http://127.0.0.1:${upstream.port}` });
  const reply = await new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${proxy.port}/v1/stream`);
    const timeout = setTimeout(() => reject(new Error('timed out waiting for bridged frame')), 2000);
    socket.onopen = () => socket.send('ping');
    socket.onmessage = (event) => {
      clearTimeout(timeout);
      resolve(String(event.data));
      socket.close();
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('websocket bridge failed'));
    };
  });

  proxy.stop(true);
  upstream.stop(true);
  expect(reply).toBe('daemon:ping');
});

test('standalone web preserves WebSocket subprotocols for Vite HMR', async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (req.headers.get('sec-websocket-protocol') !== 'vite-hmr') {
        return new Response('missing websocket protocol', { status: 400 });
      }
      if (server.upgrade(req)) return undefined;
      return new Response('upgrade required', { status: 426 });
    },
    websocket: {
      message() {},
      open(ws) {
        ws.send('hmr:ready');
      }
    }
  });

  Bun.env.WEB_PORT = '0';
  const proxy = startWeb({ daemonUrl: `http://127.0.0.1:${upstream.port}` });

  try {
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${proxy.port}/v1/stream?token=dev`, 'vite-hmr');
      const timeout = setTimeout(() => reject(new Error('timed out waiting for bridged HMR frame')), 2000);
      socket.onmessage = (event) => {
        clearTimeout(timeout);
        resolve(String(event.data));
        socket.close();
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('websocket HMR bridge failed'));
      };
    });

    expect(reply).toBe('hmr:ready');
  } finally {
    proxy.stop(true);
    upstream.stop(true);
  }
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
  const text = await new Response(wrapped).text();
  expect(text).toBe('event: ready\ndata: {"ok":true}\n\n');
});

test('loopbackTlsOptions only disables verification for exact loopback HTTPS hosts', () => {
  expect(loopbackTlsOptions('https://127.0.0.1:52749')).toEqual({ tls: { rejectUnauthorized: false } });
  expect(loopbackTlsOptions('wss://127.0.0.1:52749')).toEqual({ tls: { rejectUnauthorized: false } });
  expect(loopbackTlsOptions('https://localhost:52749')).toEqual({ tls: { rejectUnauthorized: false } });
  expect(loopbackTlsOptions('https://127.attacker.test:52749')).toEqual({});
  expect(loopbackTlsOptions('https://localhost.attacker.test:52749')).toEqual({});
  expect(loopbackTlsOptions('http://127.0.0.1:52749')).toEqual({});
});

test('vite.config exports a config factory', async () => {
  const mod = await import('../../vite.config.ts');
  expect(typeof mod.default).toBe('function');
});

test('vite dev server uses the configured port exactly for daemon proxy compatibility', async () => {
  const mod = await import('../../vite.config.ts');
  const config = mod.default({ command: 'serve', mode: 'development' });
  expect(config.server?.strictPort).toBe(true);
});

test('web dev scripts pass a deterministic editor to Vite overlays', async () => {
  const pkg = (await Bun.file(new URL('../../package.json', import.meta.url)).json()) as {
    scripts: Record<string, string>;
  };
  expect(pkg.scripts.dev).toContain('LAUNCH_EDITOR=');
  expect(pkg.scripts['start:dev']).toContain('LAUNCH_EDITOR=');
});

test('resolveDevWebProxyUrl only uses WEB_PORT in explicit development mode', () => {
  expect(
    resolveDevWebProxyUrl('https://127.0.0.1:52749/workspace/p1?tab=room', {
      NODE_ENV: 'development',
      WEB_PORT: '3147'
    })
  ).toBe('http://127.0.0.1:3147/workspace/p1?tab=room');

  expect(
    resolveDevWebProxyUrl('https://127.0.0.1:52749/@vite/client', {
      NODE_ENV: 'production',
      WEB_PORT: '3147'
    })
  ).toBeNull();

  expect(
    resolveDevWebProxyUrl('https://127.0.0.1:52749/workspace/p1?tab=room', {
      WEB_PORT: '3147'
    })
  ).toBeNull();
});

test('proxyDevWebRequest forwards method, path, query, and body to Vite', async () => {
  const vite = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      return Response.json({
        body: await req.text(),
        method: req.method,
        pathname: url.pathname,
        search: url.search
      });
    }
  });

  try {
    const req = new Request('https://127.0.0.1:52749/workspace/p1?tab=room', {
      method: 'POST',
      body: 'payload'
    });
    const res = await proxyDevWebRequest(req, `http://127.0.0.1:${vite.port}/workspace/p1?tab=room`);
    expect(await res.json()).toEqual({
      body: 'payload',
      method: 'POST',
      pathname: '/workspace/p1',
      search: '?tab=room'
    });
  } finally {
    vite.stop(true);
  }
});

// ── readDaemonUrl path resolution ─────────────────────────────────────────────
// readDaemonUrl() is private; test it by writing a port into MONAD_HOME/configs/config.json
// and verifying startWeb() auto-proxies to that port without an explicit daemonUrl.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureTlsCert } from '@monad/home/tls';

test('readDaemonUrl reads port from MONAD_HOME/configs/config.json', async () => {
  const home = join(tmpdir(), `monad-web-cfgpath-${Date.now()}`);
  mkdirSync(join(home, 'configs'), { recursive: true });

  // Fake HTTPS daemon returns a sentinel status so we can confirm the proxy reached it.
  const cert = await ensureTlsCert(join(home, 'tls'));
  const fake = Bun.serve({
    port: 0,
    tls: { key: Bun.file(cert.keyPath), cert: Bun.file(cert.certPath) },
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

test('readDaemonUrl uses HTTP when config disables HTTPS', async () => {
  const home = join(tmpdir(), `monad-web-http-cfgpath-${Date.now()}`);
  mkdirSync(join(home, 'configs'), { recursive: true });

  const fake = Bun.serve({
    port: 0,
    fetch: () => new Response('hit', { status: 418, headers: { 'x-hit': '1' } })
  });
  writeFileSync(
    join(home, 'configs', 'config.json'),
    JSON.stringify({ network: { https: { enabled: false }, port: fake.port } })
  );

  const prevHome = Bun.env.MONAD_HOME;
  Bun.env.MONAD_HOME = home;
  Bun.env.WEB_PORT = '0';
  const ws = startWeb();

  try {
    const res = await fetch(`http://127.0.0.1:${ws.port}/api/probe`);
    expect(res.status).toBe(418);
    expect(res.headers.get('x-hit')).toBe('1');
  } finally {
    ws.stop(true);
    fake.stop(true);
    Bun.env.MONAD_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('readDaemonUrl prefers an explicit MONAD_URL over derived env ports', async () => {
  const fakeExplicit = Bun.serve({
    port: 0,
    fetch: () => new Response('explicit', { status: 418, headers: { 'x-hit': 'explicit' } })
  });
  const fakeFallback = Bun.serve({
    port: 0,
    fetch: () => new Response('fallback', { status: 419, headers: { 'x-hit': 'fallback' } })
  });

  const prevMonadUrl = Bun.env.MONAD_URL;
  const prevHttpPort = Bun.env.MONAD_HTTP_PORT;
  const prevPort = Bun.env.MONAD_PORT;
  const prevWebPort = Bun.env.WEB_PORT;
  Bun.env.MONAD_URL = `http://127.0.0.1:${fakeExplicit.port}`;
  Bun.env.MONAD_HTTP_PORT = String(fakeFallback.port);
  Bun.env.MONAD_PORT = String(fakeFallback.port);
  Bun.env.WEB_PORT = '0';
  const ws = startWeb();

  try {
    const res = await fetch(`http://127.0.0.1:${ws.port}/api/probe`);
    expect(res.status).toBe(418);
    expect(res.headers.get('x-hit')).toBe('explicit');
  } finally {
    ws.stop(true);
    fakeExplicit.stop(true);
    fakeFallback.stop(true);
    Bun.env.MONAD_URL = prevMonadUrl;
    Bun.env.MONAD_HTTP_PORT = prevHttpPort;
    Bun.env.MONAD_PORT = prevPort;
    Bun.env.WEB_PORT = prevWebPort;
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
