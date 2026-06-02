import { expect, test } from 'bun:test';

import { command as send } from '../../src/commands/session/send.ts';
import { command as status } from '../../src/commands/status.ts';
import { CliError, type CommandContext, EXIT } from '../../src/commands/types.ts';

// Behavioral unit tests with a stubbed client — no daemon. These pin the exit-code contract and
// the send-mode routing (stream by default / --no-stream / --detach).

function ctx(positionals: string[], flags: Record<string, unknown>, client: unknown): CommandContext {
  return {
    positionals,
    flags,
    globals: { json: false, quiet: false, verbose: 0, yes: false, color: false },
    client: client as CommandContext['client']
  };
}

async function silently(fn: () => Promise<void>): Promise<void> {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
}

// ── status exit codes ───────────────────────────────────────────────────────────

test('status exits EXIT.DAEMON when the daemon is unreachable (null body)', async () => {
  const client = { treaty: { health: { get: async () => ({ data: null }) } } };
  try {
    await silently(() => status.run(ctx([], {}, client)));
    expect.unreachable('should throw');
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(EXIT.DAEMON);
  }
});

test('status succeeds (no throw) when the daemon answers', async () => {
  const client = { treaty: { health: { get: async () => ({ data: { status: 'ok', version: '0.0.1' } }) } } };
  await silently(() => status.run(ctx([], {}, client)));
});

// ── send-mode routing ───────────────────────────────────────────────────────────

function sendStub() {
  const calls = { stream: 0, detach: 0, block: 0 };
  const client = {
    sendStreamable: async () => {
      calls.stream++;
    },
    treaty: {
      v1: {
        sessions: (_: unknown) => ({
          messages: {
            post: async () => {
              calls.detach++;
              return { data: {} };
            },
            block: {
              post: async () => {
                calls.block++;
                return { data: { message: { text: 'reply' } }, status: 200 };
              }
            }
          }
        })
      }
    }
  };
  return { client, calls };
}

test('send streams the reply by default', async () => {
  const { client, calls } = sendStub();
  await silently(() => send.run(ctx(['ses_1', 'hello'], {}, client)));
  expect(calls).toEqual({ stream: 1, detach: 0, block: 0 });
});

test('send --no-stream uses the blocking endpoint', async () => {
  const { client, calls } = sendStub();
  await silently(() => send.run(ctx(['ses_1', 'hello'], { stream: false }, client)));
  expect(calls).toEqual({ stream: 0, detach: 0, block: 1 });
});

test('send --detach posts without waiting for a reply', async () => {
  const { client, calls } = sendStub();
  await silently(() => send.run(ctx(['ses_1', 'hello'], { detach: true }, client)));
  expect(calls).toEqual({ stream: 0, detach: 1, block: 0 });
});

test('send without a session id is a usage error', async () => {
  const { client } = sendStub();
  await expect(silently(() => send.run(ctx([], {}, client)))).rejects.toBeInstanceOf(CliError);
});
