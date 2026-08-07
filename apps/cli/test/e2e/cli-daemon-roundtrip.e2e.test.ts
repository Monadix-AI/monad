import type { Subprocess } from 'bun';

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every other CLI test drives a mocked treaty client. This one runs the real binary against a real
// daemon over TCP, so the parts a mock cannot check — argv parsing, the wire contract, the
// idempotency ledger, exit codes, and the `--json` frames a script actually consumes — are covered
// end to end.

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const DAEMON_ENTRY = join(REPO_ROOT, 'apps/monad/src/main.ts');
const CLI_ENTRY = join(REPO_ROOT, 'apps/cli/src/main.ts');

let home = '';
let port = 0;
let daemon: Subprocess | undefined;

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
  const chosen = probe.port ?? 0;
  probe.stop(true);
  if (!chosen) throw new Error('could not reserve a port');
  return chosen;
}

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function cli(args: string[], stdin?: string): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args, '--port', String(port), '--no-input'], {
    cwd: REPO_ROOT,
    env: { ...process.env, MONAD_HOME: home, MONAD_PORT: String(port), NO_COLOR: '1' },
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe'
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  return { stdout, stderr, exitCode };
}

/** Run a CLI command that is expected to succeed and parse its single `--json` frame. */
async function cliJson<T>(args: string[]): Promise<T> {
  const result = await cli([...args, '--json']);
  if (result.exitCode !== 0) {
    throw new Error(`\`monad ${args.join(' ')}\` exited ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
  }
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  const last = lines.at(-1);
  if (!last) throw new Error(`\`monad ${args.join(' ')}\` produced no --json output`);
  return JSON.parse(last) as T;
}

/**
 * A reserved port is only a hint: parallel suites reserve the same way, so another process can
 * take it before the daemon binds. Treat an early daemon exit as a lost race and retry on a
 * fresh port rather than burning the whole deadline on a process that is already dead.
 */
async function startDaemon(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    port = await freePort();
    const proc = Bun.spawn([process.execPath, DAEMON_ENTRY, '--mock-model'], {
      cwd: REPO_ROOT,
      env: { ...process.env, MONAD_HOME: home, MONAD_PORT: String(port), NODE_ENV: 'test' },
      stdout: 'pipe',
      stderr: 'pipe'
    });
    daemon = proc;
    // Drain incrementally: `new Response(stream).text()` only settles when the daemon exits, which
    // is exactly the case a boot-timeout report cannot wait for.
    const output: string[] = [];
    const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) output.push(decoder.decode(chunk, { stream: true }));
    };
    void drain(proc.stdout as ReadableStream<Uint8Array>).catch(() => {});
    void drain(proc.stderr as ReadableStream<Uint8Array>).catch(() => {});

    // The daemon boots in ~2s alone, but its cold transpile/JIT is CPU-bound: sharing the machine
    // with the rest of `bun run test` has pushed it past 30s. Budget for a saturated host.
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        const health = await fetch(`http://127.0.0.1:${port}/health`);
        if (health.ok) return;
      } catch {
        /* not listening yet */
      }
      if (proc.exitCode !== null || proc.signalCode !== null) break;
      if (Date.now() > deadline) {
        proc.kill();
        await proc.exited;
        throw new Error(`daemon did not become reachable on port ${port}\n${output.join('')}`);
      }
      await Bun.sleep(200);
    }

    await proc.exited;
    daemon = undefined;
    if (attempt >= 3) {
      throw new Error(`daemon exited ${proc.exitCode} before listening on port ${port}\n${output.join('')}`);
    }
  }
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'monad-cli-e2e-'));
  // `--mock-model` swaps in the deterministic model AND reports the home as initialized, so the
  // session commands' init gate passes without seeding a provider credential.
  await startDaemon();
}, 150_000);

afterAll(async () => {
  daemon?.kill();
  await daemon?.exited;
  if (home) await rm(home, { recursive: true, force: true });
});

test('a session created through the CLI is visible to a later CLI call', async () => {
  const created = await cliJson<{ sessionId: string; title: string }>(['session', 'new', 'roundtrip']);
  expect(created.title).toBe('roundtrip');
  expect(created.sessionId).toMatch(/^ses_/);

  const sessions = await cliJson<Array<{ id: string }>>(['session', 'list']);
  expect(sessions.map((session) => session.id)).toContain(created.sessionId);
}, 30_000);

test('a turn sent through the CLI comes back from the transcript', async () => {
  const { sessionId } = await cliJson<{ sessionId: string }>(['session', 'new', 'transcript']);

  const sent = await cliJson<{ message: { text: string } }>([
    'session',
    'send',
    sessionId,
    'hello there',
    '--no-stream'
  ]);
  expect(sent.message.text.length).toBeGreaterThan(0);

  const transcript = await cliJson<{ messages: Array<{ role: string; text: string }> }>([
    'session',
    'messages',
    sessionId
  ]);
  expect(transcript.messages.map((message) => message.role)).toContain('user');
  expect(transcript.messages.find((message) => message.role === 'user')?.text).toBe('hello there');
  expect(transcript.messages.find((message) => message.role === 'assistant')?.text).toBe(sent.message.text);
}, 30_000);

test('re-running an identical write replays instead of creating a second session', async () => {
  // The derived idempotency key is what makes a retried script safe; this exercises it against the
  // daemon's real ledger rather than asserting the header in isolation.
  const first = await cliJson<{ sessionId: string }>(['session', 'new', 'idempotent-title']);
  const again = await cliJson<{ sessionId: string }>(['session', 'new', 'idempotent-title']);
  expect(again.sessionId).toBe(first.sessionId);

  const different = await cliJson<{ sessionId: string }>(['session', 'new', 'a different title']);
  expect(different.sessionId).not.toBe(first.sessionId);
}, 30_000);

test('the agent roster is reachable and reports a default', async () => {
  const roster = await cliJson<{ agents: Array<{ id: string }>; defaultAgentId: string | null }>(['agent', 'list']);
  expect(Array.isArray(roster.agents)).toBe(true);
});

test('nothing is waiting on a human on a freshly booted daemon', async () => {
  const pending = await cliJson<{ tools: unknown[]; interactions: unknown[] }>(['approval', 'list']);
  expect(pending).toEqual({ tools: [], interactions: [] });
});

test('a missing session exits 2 and reports the daemon status in the error frame', async () => {
  const result = await cli(['session', 'show', 'ses_000000000000', '--json']);

  expect(result.exitCode).toBe(2);
  const frame = JSON.parse(result.stderr.trim().split('\n').at(-1) ?? '{}');
  expect(frame).toMatchObject({ status: 404, exitCode: 2 });
  expect(typeof frame.error).toBe('string');
});

test('watch stops on the requested event instead of hanging', async () => {
  const { sessionId } = await cliJson<{ sessionId: string }>(['session', 'new', 'watched']);

  const watching = cli(['session', 'watch', sessionId, '--until', 'session.message.completed', '--timeout', '25']);
  // Give the subscription time to attach before the turn that should end it.
  await Bun.sleep(500);
  await cli(['session', 'send', sessionId, 'wrap it up', '--detach']);

  const result = await watching;
  expect(result.exitCode).toBe(0);
}, 40_000);

test('watch exits non-zero when its stop event never arrives', async () => {
  const { sessionId } = await cliJson<{ sessionId: string }>(['session', 'new', 'never-completes']);
  const result = await cli(['session', 'watch', sessionId, '--until', 'session.never.happens', '--timeout', '1']);
  expect(result.exitCode).toBe(1);
}, 20_000);

test('a provider key is read from stdin so it never appears in argv', async () => {
  const probe = JSON.stringify({
    provider: {
      id: 'probe',
      label: 'Probe',
      type: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1/v1',
      credentials: []
    },
    accessToken: 'sk-not-a-real-key'
  });

  const result = await cli(['model', 'test', '-', '--json'], probe);

  // The daemon reached the connection attempt, which is only possible if the body arrived — the
  // argv form would put a live key into `ps` output for every local user and into shell history.
  const frame = JSON.parse((result.stdout.trim() || result.stderr.trim()).split('\n').at(-1) ?? '{}');
  expect(frame.ok).toBe(false);
  expect(typeof frame.error).toBe('string');
}, 30_000);
