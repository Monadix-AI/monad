// Release: SPA assets are served from Bun's embedded filesystem — no sidecar, no Node runtime.
// attachWebRoutes() mounts onto the daemon's Elysia app so everything shares one port.
// Dev: Vite runs on :3000; startWeb() is only used for standalone `monad web`.

import type { App } from '@monad/monad/start';
import type { ServerWebSocket } from 'bun';

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { networkConfigOverrideSchema } from '@monad/environment';
import { resolveDaemonUrl } from '@monad/environment/network-endpoints';
import { getPaths } from '@monad/environment/paths';
import { createLogger } from '@monad/logger';
import { z } from 'zod';

import { loopbackTlsOptions } from '../src/lib/loopback-tls';
import { proxyResponseBody } from '../src/lib/proxy-stream';

const logger = createLogger('monad-web');
const meshConfigSchema = z.object({ network: networkConfigOverrideSchema.optional() });

type EmbeddedAsset = {
  blob: Blob;
  headers: Headers;
};

type WebSocketProxyData = {
  pending: WebSocketMessage[];
  protocol?: string;
  target: string;
  upstream?: WebSocket;
};

type WebSocketMessage = string | ArrayBuffer;
type Env = { NODE_ENV?: string; WEB_PORT?: string };
type WebSocketBridge = {
  close: () => void;
  data?: { request?: Request };
  send: (message: string | ArrayBuffer) => unknown;
};

// Build a URL-path → Blob map from embedded assets once at startup.
// build-release embeds gzip-compressed apps/web/out.gz/ files as extra entrypoints; Bun.embeddedFiles
// names include the source path tail (e.g. ".../apps/web/out.gz/assets/foo.js.gz"). Strip the
// embed prefix and trailing ".gz" to get the URL path. Also keep legacy uncompressed apps/web/out/
// support for dev/tests and older local binaries.
// Bun types declare embeddedFiles as Blob[], but each item is a subclass with a `name` property.
const WEB_EMBED_PREFIX = 'apps/web/out/';
const WEB_GZIP_EMBED_PREFIX = 'apps/web/out.gz/';
const ASSETS = buildAssetMap(Bun.embeddedFiles as Array<Blob & { name: string }>);

function contentTypeFor(pathname: string): string {
  switch (extname(pathname)) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.gif':
      return 'image/gif';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.ico':
      return 'image/x-icon';
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
    case '.map':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.txt':
      return 'text/plain; charset=utf-8';
    case '.wasm':
      return 'application/wasm';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

export function buildAssetMap(files: Array<Blob & { name: string }>): Map<string, EmbeddedAsset> {
  const assets = new Map<string, EmbeddedAsset>();
  for (const file of files) {
    const gzipIndex = file.name.lastIndexOf(WEB_GZIP_EMBED_PREFIX);
    const legacyIndex = file.name.lastIndexOf(WEB_EMBED_PREFIX);
    const gzip = gzipIndex !== -1 && file.name.endsWith('.gz');
    const legacy = legacyIndex !== -1;
    if (!gzip && !legacy) continue;

    const rel = gzip
      ? file.name.slice(gzipIndex + WEB_GZIP_EMBED_PREFIX.length, -'.gz'.length)
      : file.name.slice(legacyIndex + WEB_EMBED_PREFIX.length);
    const urlPath = `/${rel}`;
    const headers = new Headers({ 'content-type': contentTypeFor(urlPath) });
    if (gzip) headers.set('content-encoding', 'gzip');
    if (urlPath.endsWith('.html')) headers.set('cache-control', 'no-cache');
    else if (urlPath.startsWith('/assets/')) headers.set('cache-control', 'public, max-age=31536000, immutable');
    if (urlPath === '/favicon.ico') headers.set('cache-control', 'public, max-age=86400');
    assets.set(urlPath, { blob: file, headers });

    if (urlPath.endsWith('/index.html')) {
      const dir = urlPath.slice(0, -'index.html'.length);
      assets.set(dir, { blob: file, headers });
      if (dir.length > 1) assets.set(dir.slice(0, -1), { blob: file, headers });
    }
  }
  return assets;
}

export function serveAssetFromMap(assets: Map<string, EmbeddedAsset>, pathname: string): Response {
  const hit = assets.get(pathname) ?? (pathname === '/' ? assets.get('/index.html') : undefined);
  if (hit) return new Response(hit.blob, { status: 200, headers: hit.headers });
  if (pathname.startsWith('/assets/')) {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain;charset=utf-8' } });
  }
  // Unknown path: serve SPA shell and let the client router handle it (deep links, /sessions/:id).
  const shell = assets.get('/index.html');
  if (shell) return new Response(shell.blob, { status: 200, headers: shell.headers });
  return new Response('Not found', { status: 404 });
}

const RELEASE_STATIC_ROUTES = [
  '/assets/*',
  '/capability-icons/*',
  '/model-role-icons/*',
  '/favicon.ico',
  '/favicon.svg',
  '/mochi.webp',
  '/monad-icon-vector-solid.svg',
  '/monad-logo-vector-solid.svg'
] as const;

const RELEASE_SPA_ROUTES = ['/', '/init', '/inbox', '/sessions/*', '/workspace/*', '/settings/*', '/studio/*'] as const;

function serveAsset(pathname: string): Response {
  return serveAssetFromMap(ASSETS, pathname);
}

export function resolveDevWebProxyUrl(
  requestUrl: string,
  env: Env = Bun.env,
  protocol: 'http' | 'ws' = 'http'
): string | null {
  if (env.NODE_ENV !== 'development' || !env.WEB_PORT) return null;
  const source = new URL(requestUrl);
  return `${protocol}://127.0.0.1:${env.WEB_PORT}${source.pathname}${source.search}`;
}

export async function proxyDevWebRequest(req: Request, target: string): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('upgrade');
  headers.delete('connection');
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
  try {
    const upstream = await fetch(target, { method: req.method, headers, body });
    const resHeaders = new Headers(upstream.headers);
    resHeaders.delete('transfer-encoding');
    return new Response(proxyResponseBody(upstream), { status: upstream.status, headers: resHeaders });
  } catch {
    return new Response('Bad Gateway', { status: 502 });
  }
}

function bridgeWebSocketToTarget(
  client: WebSocketBridge,
  target: string,
  data: WebSocketProxyData = { pending: [], target }
): WebSocketProxyData {
  data.target = target;
  const upstream = openUpstreamWebSocket(target, data.protocol);
  data.upstream = upstream;
  upstream.binaryType = 'arraybuffer';
  upstream.onopen = () => {
    const pending = data.pending.splice(0);
    for (const message of pending) sendWhenOpen(upstream, message);
  };
  upstream.onmessage = (event) => {
    client.send(normalizeWebSocketMessage(event.data as string | ArrayBuffer | Uint8Array));
  };
  upstream.onclose = () => client.close();
  upstream.onerror = () => client.close();
  return data;
}

/**
 * Mount the SPA onto an existing Elysia app (same-port, same-process mode).
 * The daemon's /v1/* and /health routes take priority; everything else falls
 * through to the SPA catch-all.
 */
export function attachWebRoutes(app: App): void {
  if (resolveDevWebProxyUrl('http://127.0.0.1/')) {
    for (const route of RELEASE_SPA_ROUTES) {
      app.get(route, async ({ request }) => {
        const target = resolveDevWebProxyUrl(request.url);
        return target ? proxyDevWebRequest(request, target) : new Response('Not found', { status: 404 });
      });
    }
    return;
  }

  for (const route of RELEASE_STATIC_ROUTES) {
    app.get(route, ({ path }) => serveAsset(path));
  }
  for (const route of RELEASE_SPA_ROUTES) {
    app.get(route, ({ path }) => serveAsset(path));
  }
}

function daemonUrlFromMesh(raw: string): string {
  const network = meshConfigSchema.parse(JSON.parse(raw)).network;
  return resolveDaemonUrl({ network, env: Bun.env });
}

export function readDaemonUrl(): string {
  if (Bun.env.MONAD_URL) return resolveDaemonUrl({ env: Bun.env });
  try {
    const meshPath = getPaths().mesh;
    const raw = readFileSync(meshPath, 'utf-8');
    return daemonUrlFromMesh(raw);
  } catch {
    return resolveDaemonUrl({ env: Bun.env });
  }
}

function proxyPath(pathname: string): string | null {
  if (pathname === '/api') return '/';
  if (pathname.startsWith('/api/')) return `/${pathname.slice('/api/'.length)}`;
  if (pathname === '/v1' || pathname.startsWith('/v1/')) return pathname;
  return null;
}

function webSocketTarget(daemon: string, pathname: string, search: string): string {
  return `${daemon.replace(/^http/, 'ws')}${pathname}${search}`;
}

function normalizeWebSocketMessage(message: string | ArrayBuffer | Uint8Array): WebSocketMessage {
  if (typeof message === 'string' || message instanceof ArrayBuffer) return message;
  const copy = new Uint8Array(message.byteLength);
  copy.set(message);
  return copy.buffer;
}

function openUpstreamWebSocket(target: string, protocol?: string): WebSocket {
  const connect = WebSocket as unknown as {
    new (url: string, options?: { tls?: { rejectUnauthorized: boolean } }): WebSocket;
    new (url: string, protocol: string, options?: { tls?: { rejectUnauthorized: boolean } }): WebSocket;
  };
  const options = loopbackTlsOptions(target);
  return protocol ? new connect(target, protocol, options) : new connect(target, options);
}

function sendWhenOpen(ws: WebSocket, message: string | ArrayBuffer | Uint8Array): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  ws.send(normalizeWebSocketMessage(message));
  return true;
}

function sendToClient(
  client: ServerWebSocket<WebSocketProxyData>,
  message: string | ArrayBuffer | Uint8Array
): boolean {
  client.send(normalizeWebSocketMessage(message));
  return true;
}

/**
 * Standalone web server: own port + /api/* proxy to a separately-running daemon.
 * Used by `monad web`. Pass `daemonUrl` in tests to inject a mock provider.
 */
export function startWeb(opts?: { daemonUrl?: string }) {
  const DAEMON = opts?.daemonUrl ?? readDaemonUrl();
  const PORT = Number(Bun.env.WEB_PORT ?? 3000);
  const HOST = Bun.env.WEB_HOST ?? '0.0.0.0';

  const server = Bun.serve<WebSocketProxyData>({
    port: PORT,
    hostname: HOST,
    async fetch(req, server) {
      const { pathname, search } = new URL(req.url);
      const providerPath = proxyPath(pathname);

      if (providerPath) {
        if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
          const target = webSocketTarget(DAEMON, providerPath, search);
          if (
            server.upgrade(req, {
              data: {
                pending: [],
                protocol: req.headers.get('sec-websocket-protocol') ?? undefined,
                target
              }
            })
          )
            return undefined;
          return new Response('websocket upgrade failed', { status: 400 });
        }
        const headers = new Headers(req.headers);
        headers.delete('host');
        headers.delete('upgrade');
        headers.delete('connection');
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
        try {
          const provider = await fetch(`${DAEMON}${providerPath}${search}`, {
            method: req.method,
            headers,
            body,
            ...loopbackTlsOptions(DAEMON)
          } as RequestInit & { tls?: { rejectUnauthorized: boolean } });
          // Strip transfer-encoding so SSE flows unbuffered through Bun's framing.
          const resHeaders = new Headers(provider.headers);
          resHeaders.delete('transfer-encoding');
          return new Response(proxyResponseBody(provider), { status: provider.status, headers: resHeaders });
        } catch {
          return new Response('Bad Gateway', { status: 502 });
        }
      }

      return serveAsset(pathname);
    },
    websocket: {
      open(client) {
        bridgeWebSocketToTarget(
          {
            close: () => client.close(),
            send: (message) => sendToClient(client, message)
          },
          client.data.target,
          client.data
        );
      },
      message(client, message) {
        const upstream = client.data.upstream;
        if (!upstream || !sendWhenOpen(upstream, message)) client.data.pending.push(normalizeWebSocketMessage(message));
      },
      close(client) {
        client.data.upstream?.close();
      }
    }
  });

  logger.info(`monad web listening on http://${HOST}:${server.port}  ->  daemon ${DAEMON}`);
  return server;
}

if (import.meta.main) startWeb();
