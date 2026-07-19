import type { CommandContext } from '../../src/commands/types.ts';

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPaths, initMonadHome, loadConfig } from '@monad/environment';

import { command } from '../../src/commands/pair.ts';
import { confirmInsecureRemoteAccess } from '../../src/lib/network-security.ts';

const env = { ...Bun.env };
let testDir: string;

function ctx(flags: Record<string, unknown>, yes = false): CommandContext {
  return {
    positionals: [],
    flags,
    globals: { color: false, json: false, quiet: false, verbose: 0, yes },
    client: {} as CommandContext['client']
  };
}

beforeEach(async () => {
  testDir = join(tmpdir(), `monad-cli-pair-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  Bun.env.MONAD_HOME = testDir;
  await initMonadHome(getPaths());
});

afterEach(async () => {
  Object.assign(Bun.env, env);
  if (!('MONAD_HOME' in env)) delete Bun.env.MONAD_HOME;
  await rm(testDir, { recursive: true, force: true });
});

test('pair defaults remote access to HTTPS', async () => {
  await command.run(ctx({}));

  const cfg = await loadConfig(getPaths());
  expect(cfg?.network).toMatchObject({
    https: { enabled: true },
    remoteAccess: { enabled: true, token: expect.any(String) }
  });
});

test('pair HTTP requires confirmation and persists the acknowledged insecure mode', async () => {
  await expect(confirmInsecureRemoteAccess(false, async () => 'n')).resolves.toBe(false);
  await expect(confirmInsecureRemoteAccess(false, async () => 'y')).resolves.toBe(true);

  await command.run(ctx({ http: true }, true));

  const cfg = await loadConfig(getPaths());
  expect(cfg?.network).toMatchObject({
    https: { enabled: false },
    remoteAccess: { enabled: true, token: expect.any(String) }
  });
});
