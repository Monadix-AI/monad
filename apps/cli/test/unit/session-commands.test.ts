import { expect, test } from 'bun:test';

import { command as abort } from '../../src/commands/session/abort.ts';
import { command as branch } from '../../src/commands/session/branch.ts';
import { command as list } from '../../src/commands/session/list.ts';
import { command as newSession } from '../../src/commands/session/new.ts';
import { command as reset } from '../../src/commands/session/reset.ts';
import { command as restore } from '../../src/commands/session/restore.ts';
import { command as rm } from '../../src/commands/session/rm.ts';
import { command as search } from '../../src/commands/session/search.ts';
import { command as show } from '../../src/commands/session/show.ts';
import { command as tree } from '../../src/commands/session/tree.ts';
import { CliError, type CommandContext, EXIT } from '../../src/commands/types.ts';

// ── helpers ────────────────────────────────────────────────────────────────────

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

function ok<T>(data: T) {
  return { data, status: 200 };
}

// ── session new ────────────────────────────────────────────────────────────────

test('session new: creates session and prints id', async () => {
  const client = {
    treaty: { v1: { sessions: { post: async () => ok({ sessionId: 'ses_abc' }) } } }
  };
  await silently(() => newSession.run(ctx(['My session'], {}, client)));
});

test('session new: throws usage error when title is missing', async () => {
  const client = { treaty: { v1: { sessions: { post: async () => ok({ sessionId: 'x' }) } } } };
  await expect(silently(() => newSession.run(ctx([], {}, client)))).rejects.toBeInstanceOf(CliError);
});

test('session new: throws when daemon returns null', async () => {
  const client = { treaty: { v1: { sessions: { post: async () => ({ data: null, status: 500 }) } } } };
  await expect(silently(() => newSession.run(ctx(['Title'], {}, client)))).rejects.toThrow();
});

// ── session list ────────────────────────────────────────────────────────────────

test('session list: prints table when sessions exist', async () => {
  const sessions = [{ id: 'ses_1', title: 'Test', state: 'active', archived: false }];
  const client = {
    treaty: {
      v1: {
        sessions: { get: async () => ok({ sessions }) }
      }
    }
  };
  await silently(() => list.run(ctx([], {}, client)));
});

test('session list: prints empty message when no sessions', async () => {
  const client = {
    treaty: { v1: { sessions: { get: async () => ok({ sessions: [] }) } } }
  };
  await silently(() => list.run(ctx([], {}, client)));
});

test('session list: filters by state when positional arg given', async () => {
  let capturedQuery: unknown;
  const client = {
    treaty: {
      v1: {
        sessions: {
          get: async ({ query }: { query: unknown }) => {
            capturedQuery = query;
            return ok({ sessions: [] });
          }
        }
      }
    }
  };
  await silently(() => list.run(ctx(['archived'], {}, client)));
  expect((capturedQuery as { state: string }).state).toBe('archived');
});

// ── session abort ────────────────────────────────────────────────────────────────

test('session abort: aborts an in-flight run', async () => {
  const client = {
    treaty: {
      v1: {
        sessions: (_: unknown) => ({ abort: { post: async () => ok({ aborted: true }) } })
      }
    }
  };
  await silently(() => abort.run(ctx(['ses_1'], {}, client)));
});

test('session abort: reports nothing to abort when session is idle', async () => {
  const client = {
    treaty: {
      v1: {
        sessions: (_: unknown) => ({ abort: { post: async () => ok({ aborted: false }) } })
      }
    }
  };
  await silently(() => abort.run(ctx(['ses_1'], {}, client)));
});

test('session abort: throws usage error when session id is missing', async () => {
  const client = { treaty: { v1: { sessions: (_: unknown) => ({ abort: { post: async () => ok({}) } }) } } };
  await expect(silently(() => abort.run(ctx([], {}, client)))).rejects.toBeInstanceOf(CliError);
});

// ── session branch ────────────────────────────────────────────────────────────────

test('session branch: forks a child session', async () => {
  const client = {
    treaty: {
      v1: {
        sessions: (_: unknown) => ({ branch: { post: async () => ok({ sessionId: 'ses_child' }) } })
      }
    }
  };
  await silently(() => branch.run(ctx(['ses_parent', 'fork title'], {}, client)));
});

test('session branch: throws usage error when session id is missing', async () => {
  const client = {
    treaty: { v1: { sessions: (_: unknown) => ({ branch: { post: async () => ok({ sessionId: 'x' }) } }) } }
  };
  await expect(silently(() => branch.run(ctx([], {}, client)))).rejects.toBeInstanceOf(CliError);
});

// ── session restore ────────────────────────────────────────────────────────────────

test('session restore: rewinds to a message checkpoint', async () => {
  const client = {
    treaty: {
      v1: {
        sessions: (_: unknown) => ({
          restore: { post: async () => ok({ restoredCount: 3, newHeadMessageId: 'msg_x' }) }
        })
      }
    }
  };
  await silently(() => restore.run(ctx(['ses_1', 'msg_x'], {}, client)));
});

test('session restore: throws usage error when missing args', async () => {
  const client = {
    treaty: { v1: { sessions: (_: unknown) => ({ restore: { post: async () => ok({}) } }) } }
  };
  await expect(silently(() => restore.run(ctx(['ses_1'], {}, client)))).rejects.toBeInstanceOf(CliError);
  await expect(silently(() => restore.run(ctx([], {}, client)))).rejects.toBeInstanceOf(CliError);
});

// ── session rm ────────────────────────────────────────────────────────────────

test('session rm: deletes a session', async () => {
  const client = {
    treaty: {
      v1: {
        sessions: (_: unknown) => ({ delete: async () => ok({ deleted: true }) })
      }
    }
  };
  await silently(() => rm.run(ctx(['ses_1'], {}, client)));
});

test('session rm: throws usage error when session id is missing', async () => {
  const client = {
    treaty: { v1: { sessions: (_: unknown) => ({ delete: async () => ok({}) }) } }
  };
  await expect(silently(() => rm.run(ctx([], {}, client)))).rejects.toBeInstanceOf(CliError);
});

// ── session reset ────────────────────────────────────────────────────────────────

test('session reset: clears messages and reports count', async () => {
  const client = {
    treaty: {
      v1: {
        sessions: (_: unknown) => ({ reset: { post: async () => ok({ clearedCount: 5 }) } })
      }
    }
  };
  await silently(() => reset.run(ctx(['ses_1'], {}, client)));
});

test('session reset: handles zero messages cleared', async () => {
  const client = {
    treaty: {
      v1: {
        sessions: (_: unknown) => ({ reset: { post: async () => ok({ clearedCount: 0 }) } })
      }
    }
  };
  await silently(() => reset.run(ctx(['ses_1'], {}, client)));
});

test('session reset: throws usage error when session id is missing', async () => {
  const client = {
    treaty: { v1: { sessions: (_: unknown) => ({ reset: { post: async () => ok({}) } }) } }
  };
  await expect(silently(() => reset.run(ctx([], {}, client)))).rejects.toBeInstanceOf(CliError);
});

// ── session show ────────────────────────────────────────────────────────────────

test('session show: prints session as JSON', async () => {
  const session = { id: 'ses_1', title: 'Test', state: 'active', archived: false };
  const client = {
    treaty: {
      v1: {
        sessions: (_: unknown) => ({ get: async () => ok({ session }) })
      }
    }
  };
  await silently(() => show.run(ctx(['ses_1'], {}, client)));
});

test('session show: throws usage error when session id is missing', async () => {
  const client = {
    treaty: { v1: { sessions: (_: unknown) => ({ get: async () => ok({ session: {} }) }) } }
  };
  await expect(silently(() => show.run(ctx([], {}, client)))).rejects.toBeInstanceOf(CliError);
});

// ── session tree ────────────────────────────────────────────────────────────────

test('session tree: shows lineage with ancestors and descendants', async () => {
  const result = {
    ancestors: [{ id: 'ses_0', title: 'Root' }],
    self: { id: 'ses_1', title: 'Current' },
    descendants: [{ id: 'ses_2', title: 'Child' }]
  };
  const client = {
    treaty: {
      v1: {
        sessions: (_: unknown) => ({ provenance: { get: async () => ok(result) } })
      }
    }
  };
  await silently(() => tree.run(ctx(['ses_1'], {}, client)));
});

test('session tree: handles root session (no ancestors or descendants)', async () => {
  const result = {
    ancestors: [],
    self: { id: 'ses_1', title: 'Root' },
    descendants: []
  };
  const client = {
    treaty: {
      v1: {
        sessions: (_: unknown) => ({ provenance: { get: async () => ok(result) } })
      }
    }
  };
  await silently(() => tree.run(ctx(['ses_1'], {}, client)));
});

test('session tree: throws usage error when session id is missing', async () => {
  const client = {
    treaty: { v1: { sessions: (_: unknown) => ({ provenance: { get: async () => ok({}) } }) } }
  };
  await expect(silently(() => tree.run(ctx([], {}, client)))).rejects.toBeInstanceOf(CliError);
});

// ── session search ────────────────────────────────────────────────────────────────

test('session search: returns hits for keyword query', async () => {
  const hits = [
    {
      transcriptTargetId: 'ses_1',
      transcriptTargetTitle: 'Test',
      matchedBy: 'keyword',
      score: 0.95,
      role: 'user',
      snippet: 'hello world'
    }
  ];
  const client = {
    treaty: {
      v1: { sessions: { search: { get: async () => ok({ hits }) } } }
    }
  };
  await silently(() => search.run(ctx(['hello', 'world'], {}, client)));
});

test('session search: prints empty message when no hits', async () => {
  const client = {
    treaty: {
      v1: { sessions: { search: { get: async () => ok({ hits: [] }) } } }
    }
  };
  await silently(() => search.run(ctx(['nomatches'], {}, client)));
});

test('session search: accepts --mode flag', async () => {
  let capturedQuery: unknown;
  const client = {
    treaty: {
      v1: {
        sessions: {
          search: {
            get: async ({ query }: { query: unknown }) => {
              capturedQuery = query;
              return ok({ hits: [] });
            }
          }
        }
      }
    }
  };
  await silently(() => search.run(ctx(['test'], { mode: 'semantic' }, client)));
  expect((capturedQuery as { mode: string }).mode).toBe('semantic');
});

test('session search: rejects invalid --mode value', async () => {
  const client = {
    treaty: { v1: { sessions: { search: { get: async () => ok({ hits: [] }) } } } }
  };
  // i18n may or may not be initialized in the test environment: match both the
  // translated string and the raw key so the assertion is stable in all cases.
  await expect(silently(() => search.run(ctx(['q'], { mode: 'invalid' }, client)))).rejects.toThrow(
    /--mode must be one of|cli\.session\.search\.invalidMode/
  );
});

test('session search: throws usage error when query is empty', async () => {
  const client = {
    treaty: { v1: { sessions: { search: { get: async () => ok({ hits: [] }) } } } }
  };
  await expect(silently(() => search.run(ctx([], {}, client)))).rejects.toBeInstanceOf(CliError);
});

// ── exit code contract ─────────────────────────────────────────────────────────

test('usage errors always carry EXIT.USAGE code', async () => {
  const check = async (fn: () => Promise<void>) => {
    try {
      await fn();
      return null;
    } catch (e) {
      return e instanceof CliError ? e.code : null;
    }
  };
  const noClient = {};
  expect(await check(() => newSession.run(ctx([], {}, noClient)))).toBe(EXIT.USAGE);
  expect(await check(() => abort.run(ctx([], {}, noClient)))).toBe(EXIT.USAGE);
  expect(await check(() => rm.run(ctx([], {}, noClient)))).toBe(EXIT.USAGE);
  expect(await check(() => reset.run(ctx([], {}, noClient)))).toBe(EXIT.USAGE);
  expect(await check(() => restore.run(ctx(['ses_1'], {}, noClient)))).toBe(EXIT.USAGE);
  expect(await check(() => show.run(ctx([], {}, noClient)))).toBe(EXIT.USAGE);
  expect(await check(() => tree.run(ctx([], {}, noClient)))).toBe(EXIT.USAGE);
  expect(await check(() => search.run(ctx([], {}, noClient)))).toBe(EXIT.USAGE);
});
