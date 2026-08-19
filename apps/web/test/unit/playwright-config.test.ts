import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolvePlaywrightBrowserChannel,
  resolvePlaywrightDaemonPort,
  resolvePlaywrightRetryPolicy,
  resolvePlaywrightRuntime,
  resolvePlaywrightShard,
  resolvePlaywrightTrace,
  resolvePlaywrightWebPort,
  resolvePlaywrightWebServerCommand,
  resolvePlaywrightWorkers
} from '../../playwright.config.ts';

test('resolvePlaywrightBrowserChannel uses native Chrome only for Windows ARM64', () => {
  expect({
    windowsArm: resolvePlaywrightBrowserChannel('win32', 'arm64'),
    windowsX64: resolvePlaywrightBrowserChannel('win32', 'x64'),
    macArm: resolvePlaywrightBrowserChannel('darwin', 'arm64')
  }).toEqual({
    windowsArm: 'chrome',
    windowsX64: undefined,
    macArm: undefined
  });
});

test('resolvePlaywrightWebPort prefers explicit WEB_PORT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'monad-pw-port-'));
  const envPath = join(dir, '.env.local');
  writeFileSync(envPath, 'WEB_PORT=3729\n');

  try {
    expect(resolvePlaywrightWebPort({ WEB_PORT: '3333' }, envPath)).toBe(3333);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePlaywrightWebPort reuses repo env WEB_PORT when explicit WEB_PORT is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'monad-pw-port-'));
  const envPath = join(dir, '.env.local');
  writeFileSync(envPath, 'MONAD_PORT=52749\nWEB_PORT=3729\n');

  try {
    expect(resolvePlaywrightWebPort({}, envPath)).toBe(3729);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePlaywrightDaemonPort reuses repo env MONAD_PORT when explicit MONAD_PORT is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'monad-pw-port-'));
  const envPath = join(dir, '.env.local');
  writeFileSync(envPath, 'MONAD_PORT=52522\nWEB_PORT=3729\n');

  try {
    expect(resolvePlaywrightDaemonPort({}, envPath)).toBe(52522);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePlaywrightDaemonPort prefers explicit MONAD_PORT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'monad-pw-port-'));
  const envPath = join(dir, '.env.local');
  writeFileSync(envPath, 'MONAD_PORT=52522\n');

  try {
    expect(resolvePlaywrightDaemonPort({ MONAD_PORT: '52666' }, envPath)).toBe(52666);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePlaywrightWebPort falls back to the Playwright default', () => {
  expect(resolvePlaywrightWebPort({}, '/no/such/env.local')).toBe(3201);
});

test('Playwright starts the installed Vite entry through an absolute runtime path', () => {
  expect(resolvePlaywrightWebServerCommand(3729, '/opt/bun/bin/bun')).toBe(
    '/opt/bun/bin/bun ./node_modules/vite/bin/vite.js --host 0.0.0.0 --port 3729'
  );
});

test('the resolved runtime skips the bun-node shim that turbo runs tasks through', () => {
  expect(resolvePlaywrightRuntime(['/tmp/bun-node-0d9b296af/bun', '/home/runner/.bun/bin/bun'], () => true)).toBe(
    '/home/runner/.bun/bin/bun'
  );
});

test('the resolved runtime falls back to PATH lookup when no candidate exists on disk', () => {
  expect(
    resolvePlaywrightRuntime(['/tmp/bun-node-x/bun', '/nowhere/bun'], (path) => path === '/tmp/bun-node-x/bun')
  ).toBe('bun');
});

test('resolvePlaywrightWorkers keeps local runs fast and limits CI runner contention', () => {
  expect({
    local: resolvePlaywrightWorkers({}),
    ci: resolvePlaywrightWorkers({ CI: '1' }),
    explicit: resolvePlaywrightWorkers({ CI: '1', PLAYWRIGHT_WORKERS: '3' })
  }).toEqual({ local: 5, ci: 2, explicit: 3 });
});

test('resolvePlaywrightTrace keeps routine local runs lean and preserves opt-in and CI diagnostics', () => {
  expect({
    local: resolvePlaywrightTrace({}),
    localDebug: resolvePlaywrightTrace({ PLAYWRIGHT_TRACE: '1' }),
    ci: resolvePlaywrightTrace({ CI: '1' })
  }).toEqual({ local: 'off', localDebug: 'retain-on-failure', ci: 'on-first-retry' });
});

test('CI retries once for trace collection but retry-pass remains a flaky gate failure', () => {
  expect({ local: resolvePlaywrightRetryPolicy({}), ci: resolvePlaywrightRetryPolicy({ CI: '1' }) }).toEqual({
    local: { retries: 0, failOnFlakyTests: false },
    ci: { retries: 1, failOnFlakyTests: true }
  });
});

test('resolvePlaywrightShard converts the CI matrix value into the Playwright contract', () => {
  expect(resolvePlaywrightShard('3/4')).toEqual({ current: 3, total: 4 });
});

test('resolvePlaywrightShard rejects an invalid or out-of-range matrix value', () => {
  expect(() => resolvePlaywrightShard('5/4')).toThrow('invalid Playwright shard: 5/4');
});
