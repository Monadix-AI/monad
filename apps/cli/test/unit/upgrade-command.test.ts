import type { PreparedUpgrade, PrepareUpgradeOptions } from '@monad/utils/release-upgrade';
import type { CommandContext } from '../../src/commands/types.ts';

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MONAD_VERSION } from '@monad/protocol';

import { createUpgradeCommand } from '../../src/commands/upgrade.ts';
import { setOutputMode } from '../../src/lib/output.ts';

class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const originalExit = process.exit;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
let output = '';
const temporaryDirs: string[] = [];

function ctx(flags: Record<string, unknown>, json = false): CommandContext {
  return {
    positionals: [],
    flags,
    globals: { json, quiet: false, verbose: 0, yes: false, color: false },
    client: {} as CommandContext['client']
  };
}

function response(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

const preparedUpgrade: PreparedUpgrade = {
  archivePath: '/cache/staged/monad-x86_64-unknown-linux-gnu.tar.gz',
  installerPath: '/cache/staged/install.sh',
  downloadDirectory: '/cache/staged'
};

function release(tag: string, prerelease = false): Record<string, unknown> {
  return { tag_name: tag, prerelease, immutable: true, assets: [] };
}

async function freshCache(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'monad-cli-upgrade-test-'));
  temporaryDirs.push(path);
  return path;
}

beforeEach(() => {
  output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.exit = ((code?: number) => {
    throw new ExitSignal(code);
  }) as typeof process.exit;
  setOutputMode({ format: 'human', quiet: false, color: false });
});

afterEach(async () => {
  process.exit = originalExit;
  process.stdout.write = originalStdoutWrite;
  setOutputMode({ format: 'human', quiet: false, color: false });
  await Promise.all(temporaryDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

test('upgrade --check --json normalizes v-prefixed release tags', async () => {
  setOutputMode({ format: 'json', quiet: false, color: false });
  const command = createUpgradeCommand({
    fetch: (async () => response({ tag_name: `v${MONAD_VERSION}` })) as unknown as typeof fetch
  });

  await command.run(ctx({ check: true }, true));

  expect(JSON.parse(output)).toEqual({
    current: MONAD_VERSION,
    latest: MONAD_VERSION,
    upToDate: true,
    channel: 'stable',
    tag: `v${MONAD_VERSION}`
  });
});

test('upgrade channel prepares the resolved release and launches the shared worker', async () => {
  const calls: string[][] = [];
  const prepared: PrepareUpgradeOptions[] = [];
  const cacheDir = await freshCache();
  const command = createUpgradeCommand({
    binaryPath: '/opt/monad/bin/monad',
    cacheDir,
    distTarget: 'x86_64-unknown-linux-gnu',
    fetch: (async () => response([release('v9.9.9-beta.2', true)])) as unknown as typeof fetch,
    isDaemonRunning: async () => false,
    parentPid: 42,
    platform: 'linux',
    prepare: async (options) => {
      prepared.push(options);
      return preparedUpgrade;
    },
    spawn: ((args: string[]) => {
      calls.push(args);
      return { exited: Promise.resolve(0) };
    }) as typeof Bun.spawn
  });

  await command.run(ctx({ channel: 'beta' }));
  expect({
    releaseTag: prepared[0]?.release.tag,
    distTarget: prepared[0]?.distTarget,
    launcher: calls[0]?.slice(0, 4),
    worker: calls[0]?.slice(-7),
    restartsDaemon: calls[0]?.join(' ').includes('"$3" restart')
  }).toEqual({
    releaseTag: 'v9.9.9-beta.2',
    distTarget: 'x86_64-unknown-linux-gnu',
    launcher: ['sh', '-c', 'nohup "$@" >/dev/null 2>&1 < /dev/null &', 'monad-upgrade-launch'],
    worker: [
      '42',
      '/cache/staged/install.sh',
      '/opt/monad/bin/monad',
      join(cacheDir, 'result.txt'),
      join(cacheDir, 'updater.log'),
      '/cache/staged',
      '/opt/monad/bin'
    ],
    restartsDaemon: false
  });
});

test('upgrade verifies GitHub release assets before launching the installer', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'monad-cli-upgrade-'));
  const installerPath = join(
    cacheDir,
    'staged',
    new Bun.CryptoHasher('sha256').update('v9.9.9').digest('hex').slice(0, 24),
    'install.sh'
  );
  const files = new Map([
    ['monad-x86_64-unknown-linux-gnu.tar.gz', new TextEncoder().encode('archive')],
    ['install.sh', new TextEncoder().encode('#!/bin/sh')]
  ]);
  let launched = false;
  const command = createUpgradeCommand({
    binaryPath: '/opt/monad/bin/monad',
    cacheDir,
    distTarget: 'x86_64-unknown-linux-gnu',
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      const asset = [...files].find(([name]) => url.endsWith(`/${name}`));
      if (asset) return new Response(asset[1]);
      return response({
        ...release('v9.9.9'),
        assets: [...files].map(([name, bytes]) => ({
          name,
          browser_download_url: `https://downloads.example/${name}`,
          size: bytes.byteLength,
          digest: `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`
        }))
      });
    }) as unknown as typeof fetch,
    isDaemonRunning: async () => false,
    parentPid: 42,
    platform: 'linux',
    spawn: ((args: string[]) => {
      launched = args.includes('/opt/monad/bin/monad') && args.includes(installerPath);
      return { exited: Promise.resolve(0) };
    }) as typeof Bun.spawn
  });

  await command.run(ctx({}));
  const attempt = JSON.parse(await Bun.file(join(cacheDir, 'attempt.json')).text());
  expect({
    launched,
    attempt: {
      targetVersion: attempt.targetVersion,
      tag: attempt.tag,
      completedAt: attempt.completedAt,
      exitCode: attempt.exitCode,
      state: attempt.state
    },
    installer: await Bun.file(installerPath).text()
  }).toEqual({
    launched: true,
    attempt: {
      targetVersion: '9.9.9',
      tag: 'v9.9.9',
      completedAt: null,
      exitCode: null,
      state: 'installing'
    },
    installer: '#!/bin/sh'
  });
  await rm(cacheDir, { force: true, recursive: true });
});

test('upgrade --tag installs an exact older release and rejects a simultaneous channel', async () => {
  const tags: string[] = [];
  const command = createUpgradeCommand({
    cacheDir: await freshCache(),
    distTarget: 'x86_64-unknown-linux-gnu',
    fetch: (async () => response(release('v0.0.0'))) as unknown as typeof fetch,
    isDaemonRunning: async () => false,
    prepare: async (options) => {
      tags.push(options.release.tag);
      return preparedUpgrade;
    },
    spawn: (() => ({ exited: Promise.resolve(0) })) as unknown as typeof Bun.spawn
  });

  await command.run(ctx({ tag: 'v0.0.0' }));
  expect(tags).toEqual(['v0.0.0']);
  await expect(command.run(ctx({ channel: 'stable', tag: 'v0.0.0' }))).rejects.toMatchObject({ code: 2 });
});

test('upgrade --force reinstalls the current exact release', async () => {
  const tags: string[] = [];
  const command = createUpgradeCommand({
    cacheDir: await freshCache(),
    distTarget: 'x86_64-unknown-linux-gnu',
    fetch: (async () => response(release(`v${MONAD_VERSION}`))) as unknown as typeof fetch,
    isDaemonRunning: async () => false,
    prepare: async (options) => {
      tags.push(options.release.tag);
      return preparedUpgrade;
    },
    spawn: (() => ({ exited: Promise.resolve(0) })) as unknown as typeof Bun.spawn
  });

  await command.run(ctx({ force: true }));
  expect(tags).toEqual([`v${MONAD_VERSION}`]);
});

test('upgrade asks the shared worker to restart a previously running daemon', async () => {
  let worker = '';
  const command = createUpgradeCommand({
    cacheDir: await freshCache(),
    distTarget: 'x86_64-unknown-linux-gnu',
    fetch: (async () => response(release('v9.9.9'))) as unknown as typeof fetch,
    isDaemonRunning: async () => true,
    platform: 'linux',
    prepare: async () => preparedUpgrade,
    spawn: ((args: string[]) => {
      worker = args.join(' ');
      return { exited: Promise.resolve(0) };
    }) as typeof Bun.spawn
  });
  await command.run(ctx({}));

  expect(worker).toContain('"$3" restart');
});

test('upgrade fails closed when shared asset verification fails', async () => {
  const command = createUpgradeCommand({
    cacheDir: await freshCache(),
    distTarget: 'x86_64-unknown-linux-gnu',
    fetch: (async () => response(release('v9.9.9'))) as unknown as typeof fetch,
    isDaemonRunning: async () => false,
    prepare: async () => {
      throw new Error('GitHub digest mismatch for install.sh');
    }
  });

  await expect(command.run(ctx({}))).rejects.toThrow('GitHub digest mismatch for install.sh');
});

test('upgrade forwards worker launcher failures as the process exit code', async () => {
  const command = createUpgradeCommand({
    cacheDir: await freshCache(),
    distTarget: 'x86_64-unknown-linux-gnu',
    fetch: (async () => response(release('v9.9.9'))) as unknown as typeof fetch,
    isDaemonRunning: async () => false,
    prepare: async () => preparedUpgrade,
    spawn: (() => ({ exited: Promise.resolve(42) })) as unknown as typeof Bun.spawn
  });

  await expect(command.run(ctx({}))).rejects.toMatchObject({ code: 42 });
});

test('upgrade exits before invoking updater when release lookup fails', async () => {
  const command = createUpgradeCommand({
    fetch: (async () => response({}, 500)) as unknown as typeof fetch
  });

  await expect(command.run(ctx({}))).rejects.toMatchObject({ code: 1 });
});
