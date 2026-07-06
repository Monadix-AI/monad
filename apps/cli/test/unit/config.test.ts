import type { CommandContext } from '../../src/commands/types.ts';

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPaths, initMonadHome, loadConfig } from '@monad/home';

import { command } from '../../src/commands/config.ts';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a CommandContext for direct command invocation in tests. */
function ctx(positionals: string[], client: unknown = null): CommandContext {
  return {
    positionals,
    flags: {},
    globals: { json: false, quiet: false, verbose: 0, yes: false, color: false },
    client: client as CommandContext['client']
  };
}

const env = { ...Bun.env };
let testDir: string;

/** Capture stdout written via process.stdout.write during fn(). */
async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Buffer) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join('');
}

beforeEach(async () => {
  testDir = join(tmpdir(), `monad-cli-config-test-${Date.now()}`);
  Bun.env.MONAD_HOME = testDir;
  await initMonadHome(getPaths());
});

afterEach(async () => {
  Object.assign(Bun.env, env);
  if (!('MONAD_HOME' in env)) delete Bun.env.MONAD_HOME;
  await rm(testDir, { recursive: true, force: true });
});

// ── path / list / get ───────────────────────────────────────────────────────────

test('config path prints the config file path', async () => {
  const output = await captureOutput(() => command.run(ctx(['path'])));
  expect(output.trim()).toBe(getPaths().config);
});

test('config list prints flattened key = value lines', async () => {
  const output = await captureOutput(() => command.run(ctx(['list'])));
  expect(output).toMatch(/tcp|uds/);
});

test('config get reads a dotted key', async () => {
  const output = await captureOutput(() => command.run(ctx(['get', 'network.transport'])));
  expect(output.trim()).toMatch(/^(tcp|uds)$/);
});

test('config get on an unknown key throws', async () => {
  await expect(captureOutput(() => command.run(ctx(['get', 'nope.nope'])))).rejects.toThrow();
});

// ── set ─────────────────────────────────────────────────────────────────────────

test('config set network.transport uds writes uds', async () => {
  await captureOutput(() => command.run(ctx(['set', 'network.transport', 'uds'])));
  const cfg = await loadConfig(getPaths().config);
  expect(cfg?.network.transport).toBe('uds');
});

test('config set coerces numeric values', async () => {
  await captureOutput(() => command.run(ctx(['set', 'network.port', '8123'])));
  const cfg = await loadConfig(getPaths().config);
  expect(cfg?.network.port).toBe(8123);
});

test('config set rejects an invalid value (schema validation)', async () => {
  await expect(captureOutput(() => command.run(ctx(['set', 'network.transport', 'grpc'])))).rejects.toThrow();
});

// ── unknown action ───────────────────────────────────────────────────────────────

test('config <unknown-action> throws usage', async () => {
  await expect(captureOutput(() => command.run(ctx(['frobnicate'])))).rejects.toThrow();
});
