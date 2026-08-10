import type { CommandContext } from '../../src/commands/types.ts';

import { afterEach, beforeEach, expect, test } from 'bun:test';
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

afterEach(() => {
  process.exit = originalExit;
  process.stdout.write = originalStdoutWrite;
  setOutputMode({ format: 'human', quiet: false, color: false });
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

test('upgrade channel invokes updater with the resolved exact tag', async () => {
  const calls: string[][] = [];
  const command = createUpgradeCommand({
    access: async () => {},
    fetch: (async () => response([{ tag_name: 'v9.9.9-beta.2', prerelease: true }])) as unknown as typeof fetch,
    isDaemonRunning: async () => false,
    spawn: ((args: string[]) => {
      calls.push(args);
      return { exited: Promise.resolve(0) };
    }) as typeof Bun.spawn,
    updaterPath: '/opt/monad/bin/monad-update'
  });

  await command.run(ctx({ channel: 'beta' }));
  expect(calls).toEqual([['/opt/monad/bin/monad-update', '--tag', 'v9.9.9-beta.2']]);
});

test('upgrade --tag installs an exact older release and rejects a simultaneous channel', async () => {
  const calls: string[][] = [];
  const command = createUpgradeCommand({
    access: async () => {},
    fetch: (async () => response({ tag_name: 'v0.0.0' })) as unknown as typeof fetch,
    isDaemonRunning: async () => false,
    spawn: ((args: string[]) => {
      calls.push(args);
      return { exited: Promise.resolve(0) };
    }) as typeof Bun.spawn,
    updaterPath: '/opt/monad/bin/monad-update'
  });

  await command.run(ctx({ tag: 'v0.0.0' }));
  expect(calls).toEqual([['/opt/monad/bin/monad-update', '--tag', 'v0.0.0']]);
  await expect(command.run(ctx({ channel: 'stable', tag: 'v0.0.0' }))).rejects.toMatchObject({ code: 2 });
});

test('upgrade --force reinstalls the current exact release', async () => {
  const calls: string[][] = [];
  const command = createUpgradeCommand({
    access: async () => {},
    fetch: (async () => response({ tag_name: `v${MONAD_VERSION}` })) as unknown as typeof fetch,
    isDaemonRunning: async () => false,
    spawn: ((args: string[]) => {
      calls.push(args);
      return { exited: Promise.resolve(0) };
    }) as typeof Bun.spawn,
    updaterPath: '/opt/monad/bin/monad-update'
  });

  await command.run(ctx({ force: true }));
  expect(calls).toEqual([['/opt/monad/bin/monad-update', '--tag', `v${MONAD_VERSION}`]]);
});

test('upgrade restarts a running daemon after the updater succeeds', async () => {
  let restarted = false;
  const command = createUpgradeCommand({
    access: async () => {},
    fetch: (async () => response({ tag_name: 'v9.9.9' })) as unknown as typeof fetch,
    isDaemonRunning: async () => true,
    restart: async () => {
      restarted = true;
    },
    spawn: (() => ({ exited: Promise.resolve(0) })) as unknown as typeof Bun.spawn,
    updaterPath: '/opt/monad/bin/monad-update'
  });
  await command.run(ctx({}));

  expect(restarted).toBe(true);
});

test('upgrade fails clearly when the dist updater is missing', async () => {
  const command = createUpgradeCommand({
    access: async () => {
      throw new Error('ENOENT');
    },
    fetch: (async () => response({ tag_name: 'v9.9.9' })) as unknown as typeof fetch,
    isDaemonRunning: async () => false,
    updaterPath: '/opt/monad/bin/monad-update'
  });

  await expect(command.run(ctx({}))).rejects.toMatchObject({ code: 1 });
  expect(output).toContain('reinstall Monad');
});

test('upgrade forwards updater failures as the process exit code', async () => {
  const command = createUpgradeCommand({
    access: async () => {},
    fetch: (async () => response({ tag_name: 'v9.9.9' })) as unknown as typeof fetch,
    isDaemonRunning: async () => false,
    spawn: (() => ({ exited: Promise.resolve(42) })) as unknown as typeof Bun.spawn,
    updaterPath: '/opt/monad/bin/monad-update'
  });

  await expect(command.run(ctx({}))).rejects.toMatchObject({ code: 42 });
});

test('upgrade exits before invoking updater when release lookup fails', async () => {
  const command = createUpgradeCommand({
    access: async () => {},
    fetch: (async () => response({}, 500)) as unknown as typeof fetch
  });

  await expect(command.run(ctx({}))).rejects.toMatchObject({ code: 1 });
});
