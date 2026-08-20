import type { CommandContext } from '../../src/commands/types.ts';

import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { command as session } from '../../src/commands/session.ts';
import { setOutputMode } from '../../src/lib/output.ts';
import { initializedInitApi } from '../helpers/initialized-client.ts';

const SESSION_ID = 'ses_STRUCTURED1';
const dirs: string[] = [];

afterEach(async () => {
  setOutputMode({ format: 'human', color: false });
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function ctx(positionals: string[], flags: Record<string, unknown> = {}): Omit<CommandContext, 'client'> {
  return {
    positionals,
    flags,
    globals: { json: true, quiet: false, verbose: 0, yes: false, color: false }
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

async function tmpFile(name: string, contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'monad-attach-'));
  dirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, contents);
  return path;
}

test('session new emits the created id in --json mode', async () => {
  setOutputMode({ json: true, color: false });
  const client = {
    treaty: {
      v1: {
        ...initializedInitApi,
        sessions: { post: async () => ({ data: { sessionId: SESSION_ID }, status: 200 }) }
      }
    }
  } as unknown as CommandContext['client'];

  const output = await captureStdout(() => session.run({ ...ctx(['new', 'a title']), client }));

  // The regression this pins: `out()` is suppressed under --json, so a write that only printed a
  // human line emitted nothing at all and a script could not capture the new id.
  expect(JSON.parse(output.trim())).toEqual({ sessionId: SESSION_ID, title: 'a title' });
});

test('session rm reports the deletion in --json mode', async () => {
  setOutputMode({ json: true, color: false });
  const client = {
    treaty: {
      v1: {
        ...initializedInitApi,
        sessions: () => ({ delete: async () => ({ data: { ok: true }, status: 200 }) })
      }
    }
  } as unknown as CommandContext['client'];

  const output = await captureStdout(() => session.run({ ...ctx(['rm', SESSION_ID]), client }));

  expect(JSON.parse(output.trim())).toEqual({ deleted: true, sessionId: SESSION_ID });
});

test('session send --detach reports the accepted turn in --json mode', async () => {
  setOutputMode({ json: true, color: false });
  const client = {
    treaty: {
      v1: {
        ...initializedInitApi,
        sessions: () => ({ messages: { post: async () => ({ data: { ok: true }, status: 200 }) } })
      }
    }
  } as unknown as CommandContext['client'];

  const output = await captureStdout(() =>
    session.run({ ...ctx(['send', SESSION_ID, 'go'], { detach: true }), client })
  );

  expect(JSON.parse(output.trim())).toEqual({ sent: true, sessionId: SESSION_ID, detached: true });
});

test('a text file rides along as a text attachment the model can read', async () => {
  const path = await tmpFile('notes.txt', 'the quick brown fox');
  const bodies: unknown[] = [];
  const client = {
    treaty: {
      v1: {
        ...initializedInitApi,
        sessions: () => ({
          messages: {
            post: async (body: unknown) => {
              bodies.push(body);
              return { data: { ok: true }, status: 200 };
            }
          }
        })
      }
    }
  } as unknown as CommandContext['client'];

  await captureStdout(() =>
    session.run({ ...ctx(['send', SESSION_ID, 'review this'], { detach: true, file: path }), client })
  );

  expect(bodies).toEqual([
    {
      text: 'review this',
      attachments: [{ kind: 'text', name: 'notes.txt', mediaType: 'text/plain', size: 19, text: 'the quick brown fox' }]
    }
  ]);
});

test('a missing attachment path fails before the turn is posted', async () => {
  let posts = 0;
  const client = {
    treaty: {
      v1: {
        ...initializedInitApi,
        sessions: () => ({
          messages: {
            post: async () => {
              posts += 1;
              return { data: { ok: true }, status: 200 };
            }
          }
        })
      }
    }
  } as unknown as CommandContext['client'];

  await expect(
    session.run({ ...ctx(['send', SESSION_ID, 'hi'], { detach: true, file: '/nope/missing.txt' }), client })
  ).rejects.toThrow();
  expect(posts).toBe(0);
});

test('session messages reads back the transcript a detached turn produced', async () => {
  setOutputMode({ json: true, color: false });
  const queries: unknown[] = [];
  const client = {
    treaty: {
      v1: {
        ...initializedInitApi,
        sessions: () => ({
          messages: {
            get: async (opts: { query: unknown }) => {
              queries.push(opts.query);
              return {
                data: {
                  messages: [{ id: 'msg_1', role: 'assistant', text: 'done', active: true, createdAt: 'now' }],
                  messageRevision: 3
                },
                status: 200
              };
            }
          }
        })
      }
    }
  } as unknown as CommandContext['client'];

  const output = await captureStdout(() =>
    session.run({ ...ctx(['messages', SESSION_ID], { limit: 2, before: 'msg_9' }), client })
  );

  expect(queries).toEqual([{ limit: 2, before: 'msg_9', includeInactive: undefined }]);
  expect(JSON.parse(output.trim())).toEqual({
    messages: [{ id: 'msg_1', role: 'assistant', text: 'done', active: true, createdAt: 'now' }],
    messageRevision: 3
  });
});
