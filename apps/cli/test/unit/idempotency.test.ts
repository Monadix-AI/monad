import type { CommandContext } from '../../src/commands/types.ts';

import { expect, test } from 'bun:test';

import { command as session } from '../../src/commands/session.ts';
import { idempotencyHeaders } from '../../src/lib/idempotency.ts';
import { initializedInitApi } from './initialized-client.ts';

const SESSION_ID = 'ses_IDEMPOTENT01';

/** The daemon rejects anything that is not `idem_` + exactly 12 alphanumerics. */
const KEY_PATTERN = /^idem_[0-9A-Za-z]{12}$/;

function ctx(positionals: string[], flags: Record<string, unknown> = {}): Omit<CommandContext, 'client'> {
  return {
    positionals,
    flags,
    globals: { json: false, quiet: false, verbose: 0, yes: false, color: false }
  };
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string | Buffer) => {
    chunks.push(typeof c === 'string' ? c : c.toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join('');
}

test('the derived key is stable for one request and differs for another', () => {
  const first = idempotencyHeaders({}, 'session.send', [SESSION_ID, 'ship it']);
  const again = idempotencyHeaders({}, 'session.send', [SESSION_ID, 'ship it']);
  const other = idempotencyHeaders({}, 'session.send', [SESSION_ID, 'ship it now']);

  expect(first['idempotency-key']).toMatch(KEY_PATTERN);
  expect(again).toEqual(first);
  expect(other['idempotency-key']).not.toBe(first['idempotency-key']);
});

test('the same text in a different session is a different write', () => {
  const here = idempotencyHeaders({}, 'session.send', [SESSION_ID, 'ship it']);
  const there = idempotencyHeaders({}, 'session.send', ['ses_ELSEWHERE01', 'ship it']);
  expect(there['idempotency-key']).not.toBe(here['idempotency-key']);
});

test('an explicit --idempotency-key overrides the derived one', () => {
  const headers = idempotencyHeaders({ 'idempotency-key': 'idem_abcDEF012345' }, 'session.send', [SESSION_ID, 'x']);
  expect(headers).toEqual({ 'idempotency-key': 'idem_abcDEF012345' });
});

test('session send --detach carries the replay key so a retried script does not double-post', async () => {
  const posts: Array<{ body: unknown; headers: unknown }> = [];
  const client = {
    treaty: {
      v1: {
        ...initializedInitApi,
        sessions: ({ id }: { id: string }) => ({
          messages: Object.assign(
            {},
            {
              post: async (body: unknown, opts: { headers: Record<string, string> }) => {
                posts.push({ body: { ...(body as object), id }, headers: opts.headers });
                return { data: { ok: true }, status: 200 };
              }
            }
          )
        })
      }
    }
  } as unknown as CommandContext['client'];

  const run = () =>
    captureStdout(() => session.run({ ...ctx(['send', SESSION_ID, 'ship', 'it'], { detach: true }), client }));
  await run();
  await run();

  expect(posts).toHaveLength(2);
  // Same command twice → the daemon sees one key and replays the first response instead of billing
  // a second turn.
  const [first, second] = posts as [(typeof posts)[number], (typeof posts)[number]];
  expect(first.headers).toEqual(second.headers);
  expect((first.headers as Record<string, string>)['idempotency-key']).toMatch(KEY_PATTERN);
});
