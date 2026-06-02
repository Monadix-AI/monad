// Release: SPA assets are served from Bun's embedded filesystem — no sidecar, no Node runtime.
// attachWebRoutes() mounts onto the daemon's Elysia app so everything shares one port.
// Dev: `next dev` runs on :3000; startWeb() is only used for standalone `monad web`.

import type { App } from '@monad/monad/start';

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { getPaths } from '@monad/home';
import { createLogger } from '@monad/logger';

import { proxyResponseBody } from '../lib/proxy-stream';

const logger = createLogger('monad-web');

type EmbeddedAsset = {
  blob: Blob;
  headers: Headers;
};

// Build a URL-path → Blob map from embedded assets once at startup.
// build-release embeds gzip-compressed apps/web/out.gz/ files as extra entrypoints; Bun.embeddedFiles
// names include the source path tail (e.g. ".../apps/web/out.gz/_next/.../foo.js.gz"). Strip the
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
  // Unknown path: serve SPA shell and let the client router handle it (deep links, /sessions/:id).
  const shell = assets.get('/index.html');
  if (shell) return new Response(shell.blob, { status: 200, headers: shell.headers });
  return new Response('Not found', { status: 404 });
}

function serveAsset(pathname: string): Response {
  return serveAssetFromMap(ASSETS, pathname);
}

/**
 * Mount the SPA onto an existing Elysia app (same-port, same-process mode).
 * The daemon's /v1/* and /health routes take priority; everything else falls
 * through to the SPA catch-all.
 */
export function attachWebRoutes(app: App): void {
  app.get('/*', ({ path }: { path: string }) => serveAsset(path));
}

function readDaemonUrl(): string {
  if (Bun.env.MONAD_URL) return Bun.env.MONAD_URL;
  try {
    const configPath = getPaths().config;
    const raw = readFileSync(configPath, 'utf-8');
    const port = (JSON.parse(raw) as { network?: { port?: number } })?.network?.port ?? 52749;
    return `http://127.0.0.1:${port}`;
  } catch {
    return 'http://127.0.0.1:52749';
  }
}

/**
 * Standalone web server: own port + /api/* proxy to a separately-running daemon.
 * Used by `monad web`. Pass `daemonUrl` in tests to inject a mock provider.
 */
export function startWeb(opts?: { daemonUrl?: string }) {
  const DAEMON = opts?.daemonUrl ?? readDaemonUrl();
  const PORT = Number(Bun.env.WEB_PORT ?? 3000);
  const HOST = Bun.env.WEB_HOST ?? '0.0.0.0';

  const server = Bun.serve({
    port: PORT,
    hostname: HOST,
    async fetch(req) {
      const { pathname, search } = new URL(req.url);

      if (pathname === '/api' || pathname.startsWith('/api/')) {
        const providerPath = pathname.slice('/api/'.length);
        const headers = new Headers(req.headers);
        headers.delete('host');
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
        try {
          const provider = await fetch(`${DAEMON}/${providerPath}${search}`, {
            method: req.method,
            headers,
            body
          });
          // Strip transfer-encoding so SSE flows unbuffered through Bun's framing.
          const resHeaders = new Headers(provider.headers);
          resHeaders.delete('transfer-encoding');
          return new Response(proxyResponseBody(provider), { status: provider.status, headers: resHeaders });
        } catch {
          return new Response('Bad Gateway', { status: 502 });
        }
      }

      return serveAsset(pathname);
    }
  });

  logger.info(`monad web listening on http://${HOST}:${server.port}  ->  daemon ${DAEMON}`);
  return server;
}

if (import.meta.main) startWeb();
