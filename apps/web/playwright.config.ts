import { existsSync, readFileSync } from 'node:fs';
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

const port = resolvePlaywrightWebPort();

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure'
  },
  webServer: {
    command: `WEB_PORT=${port} NEXT_PUBLIC_MONAD_API_BASE=/api bun run dev`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
});
