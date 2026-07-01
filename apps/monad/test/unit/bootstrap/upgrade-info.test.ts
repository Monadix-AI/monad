import type { MonadPaths } from '@monad/home';

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createUpgradeInfoMonitor } from '@/bootstrap/upgrade-info.ts';
import { makeTestPaths } from '../../helpers.ts';

const originalFetch = globalThis.fetch;

let root: string;
let paths: MonadPaths;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error('timed out waiting for upgrade info');
}

beforeEach(async () => {
  root = join(tmpdir(), `monad-upgrade-info-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  paths = makeTestPaths(root);
  await mkdir(paths.cache, { recursive: true });
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
});

test('upgrade info monitor normalizes release tags and persists successful checks', async () => {
  globalThis.fetch = (async () => response({ tag_name: 'v9.9.9' })) as unknown as typeof fetch;

  const monitor = await createUpgradeInfoMonitor(paths);
  await waitFor(() => monitor.getUpgradeInfo()?.latestVersion === '9.9.9');

  const cached = JSON.parse(await Bun.file(join(paths.cache, 'upgrade-info.json')).text()) as {
    latestVersion: string;
    latestVersionCheckedAt: string;
  };
  expect(cached.latestVersion).toBe('9.9.9');
  expect(Date.parse(cached.latestVersionCheckedAt)).not.toBeNaN();
});

test('upgrade info monitor serves cached data when the network check fails', async () => {
  await writeFile(
    join(paths.cache, 'upgrade-info.json'),
    JSON.stringify({ latestVersion: '8.0.0', latestVersionCheckedAt: '2026-01-01T00:00:00.000Z' })
  );
  globalThis.fetch = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;

  const monitor = await createUpgradeInfoMonitor(paths);

  expect(monitor.getUpgradeInfo()).toEqual({
    latestVersion: '8.0.0',
    latestVersionCheckedAt: '2026-01-01T00:00:00.000Z'
  });
});

test('upgrade info monitor ignores malformed cache and empty release payloads', async () => {
  await writeFile(join(paths.cache, 'upgrade-info.json'), '{bad json');
  globalThis.fetch = (async () => response({})) as unknown as typeof fetch;

  const monitor = await createUpgradeInfoMonitor(paths);
  await Bun.sleep(20);

  expect(monitor.getUpgradeInfo()).toBeNull();
});
