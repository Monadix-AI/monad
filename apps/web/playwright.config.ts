import { defineConfig, devices } from '@playwright/test';

const port = 3407;
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure'
  },
  webServer: {
    command: `NEXT_PUBLIC_MONAD_API_BASE=/api WEB_PORT=${port} bun --bun next dev --turbopack -p ${port}`,
    cwd: '.',
    env: {
      NEXT_PUBLIC_MONAD_API_BASE: '/api',
      WEB_PORT: String(port)
    },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    url: baseURL
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
});
