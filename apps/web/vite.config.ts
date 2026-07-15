import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { createLogger, defineConfig } from 'vite';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const APP_ROOT = import.meta.dirname;
const REPO_ENV_PATH = resolve(REPO_ROOT, '.env.local');

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

function readEnvValue(path: string, key: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const line = readFileSync(path, 'utf-8')
    .split(/\r?\n/)
    .find((entry) => entry.trim().startsWith(`${key}=`));
  if (!line) return undefined;
  return line
    .slice(line.indexOf('=') + 1)
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

export function readDaemonEndpoint(
  env: NodeJS.ProcessEnv | { MONAD_HOME?: string | undefined; MONAD_PORT?: string | undefined } = process.env,
  envPath = REPO_ENV_PATH
): { port: string; scheme: 'https' | 'http' } {
  let scheme: 'https' | 'http' = 'https';
  const envPort = parsePort(env.MONAD_PORT) ?? parsePort(readEnvValue(envPath, 'MONAD_PORT'));
  const envHome = env.MONAD_HOME ?? readEnvValue(envPath, 'MONAD_HOME');

  const configPaths = [
    envHome ? join(envHome, 'configs', 'config.json') : undefined,
    resolve(REPO_ROOT, '.dev', '.monad', 'configs', 'config.json'),
    process.env.HOME ? join(process.env.HOME, '.monad', 'configs', 'config.json') : undefined
  ].filter((path): path is string => !!path);

  for (const configPath of configPaths) {
    if (!existsSync(configPath)) continue;
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const network = (JSON.parse(raw) as { network?: { https?: { enabled?: boolean }; port?: number } })?.network;
      if (network?.https?.enabled === false) scheme = 'http';
      const port = envPort ?? network?.port;
      if (port) return { port: String(port), scheme };
    } catch {}
  }

  return { port: String(envPort ?? 52749), scheme };
}

type DestroySoonSocket = {
  destroy(): void;
  destroySoon?: () => void;
  end(): void;
};

export function ensureDestroySoon(socket: unknown): void {
  const candidate = socket as Partial<DestroySoonSocket>;
  if (typeof candidate.destroySoon === 'function') return;
  if (typeof candidate.end !== 'function' || typeof candidate.destroy !== 'function') return;
  candidate.destroySoon = function destroySoon(this: DestroySoonSocket) {
    this.end();
    this.destroy();
  };
}

export function isTransientDaemonWsProxyError(message: string, error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return message.includes('ws proxy error') && code === 'ECONNREFUSED';
}

const viteLogger = createLogger();
const logViteError = viteLogger.error.bind(viteLogger);
viteLogger.error = (message, options) => {
  if (isTransientDaemonWsProxyError(message, options?.error)) return;
  logViteError(message, options);
};

function configureBunWsProxyCompat(proxy: { on(event: string, handler: (...args: unknown[]) => void): void }): void {
  proxy.on('proxyReqWs', (_proxyReq, _req, socket) => ensureDestroySoon(socket));
}

function daemonProxyTarget(): string {
  const { port, scheme } = readDaemonEndpoint();
  return `${scheme}://127.0.0.1:${port}`;
}

export function devToolPorts(
  command: 'build' | 'serve',
  env:
    | NodeJS.ProcessEnv
    | { AI_SDK_DEVTOOLS_PORT?: string | undefined; MONAD_KV_UI_PORT?: string | undefined } = process.env,
  envPath = REPO_ENV_PATH
) {
  if (command === 'build') return {};
  return {
    aiSdk: env.AI_SDK_DEVTOOLS_PORT || readEnvValue(envPath, 'AI_SDK_DEVTOOLS_PORT') || undefined,
    kv: env.MONAD_KV_UI_PORT || readEnvValue(envPath, 'MONAD_KV_UI_PORT') || undefined,
    otel: '6006'
  };
}

const NODE_MODULES = String.raw`[/\\]node_modules[/\\](?:\.bun[/\\][^/\\]+[/\\]node_modules[/\\])?`;
const WORKSPACE_ROOT = String.raw`[/\\](?:packages|apps)[/\\]`;

export default defineConfig(({ command }) => ({
  customLogger: viteLogger,
  plugins: [
    tanstackRouter({
      generatedRouteTree: './src/routeTree.gen.ts',
      routesDirectory: './src/routes'
    }),
    react()
  ],
  cacheDir: '.vite',
  resolve: {
    alias: {
      '#': resolve(APP_ROOT, 'src'),
      '@monad/monad': resolve(REPO_ROOT, 'apps/monad/src/public-api.ts'),
      '@monad/monad/start': resolve(REPO_ROOT, 'apps/monad/src/public-api.ts'),
      '@monad/monad/log-maintenance': resolve(REPO_ROOT, 'apps/monad/src/public-log-maintenance.ts')
    }
  },
  define: {
    __MONAD_DEV_TOOL_PORTS__: JSON.stringify(devToolPorts(command)),
    __MONAD_WEB_PORT__: JSON.stringify(String(process.env.WEB_PORT ?? 3000)),
    'process.env.NODE_ENV': JSON.stringify(command === 'build' ? 'production' : 'development')
  },
  server: {
    host: '0.0.0.0',
    port: Number(process.env.WEB_PORT ?? 3000),
    strictPort: true,
    hmr: { overlay: true },
    proxy: {
      '/api': {
        configure: configureBunWsProxyCompat,
        target: daemonProxyTarget(),
        changeOrigin: true,
        secure: false,
        ws: true,
        rewrite: (path) => (path === '/api' ? '/' : path.slice('/api'.length))
      },
      '/v1': {
        configure: configureBunWsProxyCompat,
        target: daemonProxyTarget(),
        changeOrigin: true,
        secure: false,
        ws: true
      }
    }
  },
  build: {
    outDir: 'out',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        advancedChunks: {
          groups: [
            {
              name: 'monad-agent-adapters',
              test: new RegExp(`${WORKSPACE_ROOT}atoms[/\\\\]src[/\\\\]agent-adapters[/\\\\]`)
            },
            {
              name: 'monad-experience-chat',
              test: new RegExp(`${WORKSPACE_ROOT}atoms[/\\\\]src[/\\\\]workspace-experiences[/\\\\]chat-room[/\\\\]`)
            },
            {
              name: 'monad-experiences',
              test: new RegExp(`${WORKSPACE_ROOT}atoms[/\\\\]src[/\\\\]workspace-experiences[/\\\\]`)
            },
            { name: 'monad-atoms', test: new RegExp(`${WORKSPACE_ROOT}atoms[/\\\\]`) },
            {
              name: 'monad-protocol',
              test: new RegExp(`${WORKSPACE_ROOT}(?:protocol|config|home)[/\\\\]`)
            },
            {
              name: 'monad-client',
              test: new RegExp(`${WORKSPACE_ROOT}(?:client|client-rtk)[/\\\\]`)
            },
            {
              name: 'monad-ui',
              test: new RegExp(`${WORKSPACE_ROOT}(?:i18n|utils|logger|sdk-experience)[/\\\\]`)
            },
            {
              name: 'monad-runtime',
              test: new RegExp(`${WORKSPACE_ROOT}monad[/\\\\]src[/\\\\]`)
            },
            {
              name: 'vendor-react',
              test: new RegExp(`${NODE_MODULES}(?:react|react-dom|scheduler)[/\\\\]`)
            },
            { name: 'vendor-tanstack', test: new RegExp(`${NODE_MODULES}@tanstack[/\\\\]`) },
            {
              name: 'vendor-state',
              test: new RegExp(
                `${NODE_MODULES}(?:@reduxjs[/\\\\]toolkit|react-redux|redux|use-sync-external-store|zustand)[/\\\\]`
              )
            },
            {
              name: 'vendor-forms',
              test: new RegExp(`${NODE_MODULES}(?:@hookform[/\\\\]resolvers|react-hook-form|zod)[/\\\\]`)
            },
            {
              name: 'vendor-ui',
              test: new RegExp(
                `${NODE_MODULES}(?:@hugeicons[/\\\\]|@radix-ui[/\\\\]|radix-ui|motion|motion-dom|motion-utils|framer-motion)[/\\\\]`
              )
            },
            {
              name: 'vendor-diagrams',
              test: new RegExp(`${NODE_MODULES}(?:mermaid|d3-[^/\\\\]+|cytoscape)[/\\\\]`)
            },
            {
              name: 'vendor-markdown-view',
              test: new RegExp(`${NODE_MODULES}(?:@streamdown[/\\\\][^/\\\\]+|streamdown|katex)[/\\\\]`)
            },
            {
              name: 'vendor-markdown',
              test: new RegExp(
                `${NODE_MODULES}(?:hast[^/\\\\]*|mdast[^/\\\\]*|micromark[^/\\\\]*|rehype[^/\\\\]*|remark[^/\\\\]*|unified|vfile|unist-[^/\\\\]+)[/\\\\]`
              )
            },
            {
              name: 'vendor-ai',
              test: new RegExp(`${NODE_MODULES}(?:ai|@ai-sdk[/\\\\][^/\\\\]+)[/\\\\]`)
            },
            {
              name: 'vendor-utils',
              test: new RegExp(`${NODE_MODULES}(?:lodash-es|dayjs|uuid|es-toolkit)[/\\\\]`)
            }
          ]
        }
      }
    }
  }
}));
