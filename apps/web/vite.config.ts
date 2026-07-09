import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const APP_ROOT = import.meta.dirname;

function readDaemonEndpoint(): { port: string; scheme: 'https' | 'http' } {
  let scheme: 'https' | 'http' = 'https';
  const envPort = Number(process.env.MONAD_PORT);

  const configPaths = [
    process.env.MONAD_HOME ? join(process.env.MONAD_HOME, 'configs', 'config.json') : undefined,
    resolve(REPO_ROOT, '.dev', '.monad', 'configs', 'config.json'),
    process.env.HOME ? join(process.env.HOME, '.monad', 'configs', 'config.json') : undefined
  ].filter((path): path is string => !!path);

  for (const configPath of configPaths) {
    if (!existsSync(configPath)) continue;
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const network = (JSON.parse(raw) as { network?: { https?: { enabled?: boolean }; port?: number } })?.network;
      if (network?.https?.enabled === false) scheme = 'http';
      const port = envPort || network?.port;
      if (port) return { port: String(port), scheme };
    } catch {}
  }

  return { port: String(envPort || 52749), scheme };
}

function daemonProxyTarget(): string {
  const { port, scheme } = readDaemonEndpoint();
  return `${scheme}://127.0.0.1:${port}`;
}

function devToolPorts(command: 'build' | 'serve') {
  if (command === 'build') return {};
  return {
    aiSdk: process.env.AI_SDK_DEVTOOLS_PORT || undefined,
    kv: process.env.MONAD_KV_UI_PORT || undefined,
    otel: '6006'
  };
}

const NODE_MODULES = String.raw`[/\\]node_modules[/\\](?:\.bun[/\\][^/\\]+[/\\]node_modules[/\\])?`;
const WORKSPACE_ROOT = String.raw`[/\\](?:packages|apps)[/\\]`;

export default defineConfig(({ command }) => ({
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
    'process.env.NODE_ENV': JSON.stringify(command === 'build' ? 'production' : 'development')
  },
  server: {
    host: '0.0.0.0',
    port: Number(process.env.WEB_PORT ?? 3000),
    strictPort: true,
    hmr: { overlay: true },
    proxy: {
      '/api': {
        target: daemonProxyTarget(),
        changeOrigin: true,
        secure: false,
        ws: true,
        rewrite: (path) => (path === '/api' ? '/' : path.slice('/api'.length))
      },
      '/v1': {
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
              name: 'monad-experience-graph',
              test: new RegExp(`${WORKSPACE_ROOT}atoms[/\\\\]src[/\\\\]workspace-experiences[/\\\\]graph-view[/\\\\]`)
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
