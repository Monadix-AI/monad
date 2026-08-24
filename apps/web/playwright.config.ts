import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const DEFAULT_WEB_PORT = 3201;
const repoEnvPath = fileURLToPath(new URL('../../.env.local', import.meta.url));

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

export function resolvePlaywrightWebPort(
  env: NodeJS.ProcessEnv | { WEB_PORT?: string | undefined } = process.env,
  envPath = repoEnvPath
): number {
  return parsePort(env.WEB_PORT) ?? parsePort(readEnvValue(envPath, 'WEB_PORT')) ?? DEFAULT_WEB_PORT;
}

// `bunx --bun turbo` runs its tasks through a generated `bun-node-*` shim, so both PATH and
// process.execPath point at it there. Vite launched by that shim produced no output and never
// answered the port, so the server has to be started by a real Bun. Same exclusion the mesh e2e
// fixture applies when it picks a Bun to compile with.
export function resolvePlaywrightRuntime(
  candidates?: Array<string | undefined | null>,
  exists: (path: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform
): string {
  const executable = platform === 'win32' ? 'bun.exe' : 'bun';
  const runtime = (
    candidates ?? [
      env.BUN_INSTALL ? join(env.BUN_INSTALL, 'bin', executable) : undefined,
      process.execPath,
      ...(env.PATH ?? '').split(delimiter).flatMap((dir) => (dir ? [join(dir, executable)] : []))
    ]
  ).find((candidate): candidate is string => !!candidate && !candidate.includes('bun-node-') && exists(candidate));
  return runtime ?? 'bun';
}

export function resolvePlaywrightWebServerCommand(port: number, runtime = resolvePlaywrightRuntime()): string {
  return `${runtime} ./node_modules/vite/bin/vite.js --host 0.0.0.0 --port ${port}`;
}

export function resolvePlaywrightDaemonPort(
  env: NodeJS.ProcessEnv | { MONAD_PORT?: string | undefined } = process.env,
  envPath = repoEnvPath
): number | undefined {
  return parsePort(env.MONAD_PORT) ?? parsePort(readEnvValue(envPath, 'MONAD_PORT'));
}

export function resolvePlaywrightWorkers(
  env: NodeJS.ProcessEnv | { CI?: string | undefined; PLAYWRIGHT_WORKERS?: string | undefined } = process.env,
  platform = process.platform
): number {
  return parsePort(env.PLAYWRIGHT_WORKERS) ?? (env.CI ? 2 : platform === 'win32' ? 1 : 5);
}

export function resolvePlaywrightTrace(
  env: NodeJS.ProcessEnv | { CI?: string | undefined; PLAYWRIGHT_TRACE?: string | undefined } = process.env
): 'off' | 'on-first-retry' | 'retain-on-failure' {
  if (env.CI) return 'on-first-retry';
  return env.PLAYWRIGHT_TRACE ? 'retain-on-failure' : 'off';
}

export function resolvePlaywrightRetryPolicy(env: NodeJS.ProcessEnv | { CI?: string | undefined } = process.env): {
  retries: number;
  failOnFlakyTests: boolean;
} {
  return env.CI ? { retries: 1, failOnFlakyTests: true } : { retries: 0, failOnFlakyTests: false };
}

export function resolvePlaywrightBrowserChannel(
  platform = process.platform,
  arch = process.arch
): 'chrome' | undefined {
  return platform === 'win32' && arch === 'arm64' ? 'chrome' : undefined;
}

export function resolvePlaywrightShard(value = process.env.PLAYWRIGHT_SHARD):
  | {
      current: number;
      total: number;
    }
  | undefined {
  if (!value) return undefined;
  const match = /^(\d+)\/(\d+)$/.exec(value);
  const current = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || !Number.isInteger(current) || !Number.isInteger(total) || current < 1 || current > total) {
    throw new Error(`invalid Playwright shard: ${value}`);
  }
  return { current, total };
}

const port = resolvePlaywrightWebPort();
const daemonPort = resolvePlaywrightDaemonPort();
const browserChannel = resolvePlaywrightBrowserChannel();

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  ...resolvePlaywrightRetryPolicy(),
  workers: resolvePlaywrightWorkers(),
  shard: resolvePlaywrightShard(),
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: resolvePlaywrightTrace()
  },
  webServer: {
    command: resolvePlaywrightWebServerCommand(port),
    env: {
      ...(daemonPort ? { MONAD_PORT: String(daemonPort) } : {}),
      WEB_PORT: String(port),
      // TanStackRouterDevtools mounts a fixed bottom-left toggle that overlaps the app's own
      // bottom-left daemon menu button — see __root.tsx's gate on this flag.
      VITE_PLAYWRIGHT_TEST: '1'
    },
    // 127.0.0.1, not localhost: the server binds 0.0.0.0, which is IPv4 only. A host that resolves
    // localhost to ::1 first polls an address nobody listens on and fails on the deadline instead
    // of on a refused connection, with a healthy server sitting right next to it.
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    // Piped, because Playwright discards the server's output by default, which leaves a startup
    // failure indistinguishable from a slow start.
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(browserChannel ? { channel: browserChannel } : {}),
        contextOptions: {
          reducedMotion: 'reduce'
        }
      }
    }
  ]
});
