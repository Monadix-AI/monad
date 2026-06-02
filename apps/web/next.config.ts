import type { NextConfig } from 'next';

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

// Dev: /api/* is proxied to the daemon by the streaming Route Handler in app/api/[...path]/route.ts
// (a plain rewrite buffers the SSE event stream, killing live token streaming). The browser stays
// same-origin with HMR intact either way.
// Export (NEXT_OUTPUT=export): pure static SPA; the compiled binary's startWeb() does the proxy.
const isExport = Bun.env.NEXT_OUTPUT === 'export';

function readDaemonPort(): string {
  const envPort = Number(Bun.env.MONAD_PORT);
  if (envPort) return String(envPort);

  const configPaths = [
    Bun.env.MONAD_HOME ? join(Bun.env.MONAD_HOME, 'configs', 'config.json') : undefined,
    resolve(REPO_ROOT, '.dev', '.monad', 'configs', 'config.json'),
    Bun.env.HOME ? join(Bun.env.HOME, '.monad', 'configs', 'config.json') : undefined
  ].filter((path): path is string => !!path);

  for (const configPath of configPaths) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const port = (JSON.parse(raw) as { network?: { port?: number } })?.network?.port;
      if (port) return String(port);
    } catch {}
  }

  return '52749';
}

// In static-export (release) builds the SPA is co-served with the daemon on the same port via
// attachWebRoutes(), so baking a specific port would break any install where the daemon port
// differs from the build machine's MONAD_PORT. Leave the env var empty so the browser falls back
// to window.location.origin (see apps/web/lib/monad-store.ts).
//
// In dev mode the web dev server (next dev, :3000) is separate from the daemon (:52xxx), so we
// still need to bake the port so the browser can reach the daemon directly for WebSocket upgrades.
const MONAD_DAEMON_PORT = isExport ? '' : readDaemonPort();

const DEV_TOOL_PORTS = isExport
  ? {
      NEXT_PUBLIC_MONAD_KV_UI_PORT: '',
      NEXT_PUBLIC_AI_SDK_DEVTOOLS_PORT: '',
      NEXT_PUBLIC_MONAD_OTEL_UI_PORT: ''
    }
  : {
      NEXT_PUBLIC_MONAD_KV_UI_PORT: String(Number(Bun.env.MONAD_KV_UI_PORT) || 6480),
      NEXT_PUBLIC_AI_SDK_DEVTOOLS_PORT: String(Number(Bun.env.AI_SDK_DEVTOOLS_PORT) || 4983),
      NEXT_PUBLIC_MONAD_OTEL_UI_PORT: '6006'
    };

const nextConfig: NextConfig = {
  turbopack: {
    root: REPO_ROOT
  },
  reactCompiler: true,
  // Type checking is run in the dedicated CI `checks` job; skip it here to avoid
  // Next.js failing on @/ path aliases from workspace packages it doesn't own.
  typescript: { ignoreBuildErrors: true },
  // The streaming /api proxy lives in app/api/[...path]/route.proxy.ts. It's dynamic, so it can't
  // coexist with output: 'export' — gate its `.proxy.ts` extension to non-export builds so the
  // static export omits it (startWeb() proxies there instead).
  pageExtensions: isExport ? ['tsx', 'ts', 'jsx', 'js'] : ['proxy.ts', 'tsx', 'ts', 'jsx', 'js'],
  ...(isExport ? { output: 'export', images: { unoptimized: true } } : {}),
  // Expose the daemon's TCP port to the browser so the EventSocket can bypass the HTTP-only
  // /api proxy and connect to the daemon's WebSocket endpoint directly.
  env: {
    NEXT_PUBLIC_MONAD_API_BASE: isExport ? '' : '/api',
    NEXT_PUBLIC_MONAD_DAEMON_PORT: String(MONAD_DAEMON_PORT),
    ...DEV_TOOL_PORTS
  }
};

export default nextConfig;
