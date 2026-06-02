import type { CommandContext } from '../../src/commands/types.ts';

import { expect, test } from 'bun:test';

import { command as mesh } from '../../src/commands/mesh.ts';

const SESSION_ID = 'ses_MESHSCOPE001';

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

interface Recorded {
  query?: unknown;
  body?: unknown;
}

/** Minimal treaty double covering the mesh routes the command touches. `authState` drives the
 *  sign-in precheck `mesh start` runs before it spawns anything. */
function meshClient(
  runtimes: Array<{ id: string; sessionId: string }>,
  record: Record<string, Recorded>,
  authState: 'authenticated' | 'unauthenticated' | 'unknown' = 'authenticated'
) {
  const sessions = Object.assign(
    ({ id }: { id: string }) => ({
      get: async (opts: { query: unknown }) => {
        record[`get:${id}`] = { query: opts.query };
        return { data: { session: null }, status: 200 };
      },
      input: {
        post: async (body: unknown, opts: { query: unknown }) => {
          record[`input:${id}`] = { body, query: opts.query };
          return { data: { ok: true }, status: 200 };
        }
      },
      steer: {
        post: async (body: unknown, opts: { query: unknown }) => {
          record[`steer:${id}`] = { body, query: opts.query };
          return { data: { ok: true }, status: 200 };
        }
      },
      interrupt: {
        post: async (_body: unknown, opts: { query: unknown }) => {
          record[`interrupt:${id}`] = { query: opts.query };
          return { data: { ok: true }, status: 200 };
        }
      },
      stop: {
        post: async (_body: unknown, opts: { query: unknown }) => {
          record[`stop:${id}`] = { query: opts.query };
          return { data: { ok: true }, status: 200 };
        }
      },
      approval: {
        post: async (body: unknown, opts: { query: unknown }) => {
          record[`approval:${id}`] = { body, query: opts.query };
          return { data: { ok: true }, status: 200 };
        }
      }
    }),
    {
      post: async (body: unknown) => {
        record.start = { body };
        return {
          data: { session: { id: 'mesh_NEW', agentName: 'codex' } },
          status: 200
        };
      }
    }
  );
  return {
    treaty: {
      v1: {
        mesh: {
          runtimes: { get: async () => ({ data: { sessions: runtimes }, status: 200 }) },
          agents: ({ name }: { name: string }) => ({
            auth: {
              status: {
                get: async () => {
                  record[`auth:${name}`] = {};
                  return {
                    data: { agentName: name, provider: 'codex', state: authState, output: '', checkedAt: 'now' },
                    status: 200
                  };
                }
              }
            }
          }),
          sessions
        }
      }
    }
  } as unknown as CommandContext['client'];
}

test('mesh input resolves the transcript scope from the live runtime list', async () => {
  const record: Record<string, Recorded> = {};
  const client = meshClient([{ id: 'mesh_A', sessionId: SESSION_ID }], record);

  await captureStdout(() => mesh.run({ ...ctx(['input', 'mesh_A', 'do', 'the', 'thing']), client }));

  expect(record['input:mesh_A']).toEqual({
    body: { input: 'do the thing' },
    query: { transcriptTargetId: SESSION_ID }
  });
});

test('an explicit --session wins over the runtime lookup', async () => {
  const record: Record<string, Recorded> = {};
  const client = meshClient([{ id: 'mesh_A', sessionId: 'ses_STALEXXXXXXX' }], record);

  await captureStdout(() =>
    mesh.run({ ...ctx(['steer', 'mesh_A', 'change course'], { session: SESSION_ID }), client })
  );

  expect(record['steer:mesh_A']).toEqual({
    body: { input: 'change course' },
    query: { transcriptTargetId: SESSION_ID }
  });
});

test('mesh stop signals the runtime without a body', async () => {
  const record: Record<string, Recorded> = {};
  const client = meshClient([{ id: 'mesh_A', sessionId: SESSION_ID }], record);

  await captureStdout(() => mesh.run({ ...ctx(['stop', 'mesh_A']), client }));

  expect(record['stop:mesh_A']).toEqual({ query: { transcriptTargetId: SESSION_ID } });
});

test('mesh deny forwards the decision and reason for one approval request', async () => {
  const record: Record<string, Recorded> = {};
  const client = meshClient([{ id: 'mesh_A', sessionId: SESSION_ID }], record);

  await captureStdout(() =>
    mesh.run({ ...ctx(['deny', 'mesh_A', 'req_9'], { reason: 'writes outside the sandbox' }), client })
  );

  expect(record['approval:mesh_A']).toEqual({
    body: { requestId: 'req_9', allow: false, reason: 'writes outside the sandbox' },
    query: { transcriptTargetId: SESSION_ID }
  });
});

test('an unresolvable mesh session fails before any per-session request', async () => {
  const record: Record<string, Recorded> = {};
  const client = meshClient([], record);

  await expect(mesh.run({ ...ctx(['input', 'mesh_GONE', 'hi']), client })).rejects.toThrow();
  expect(Object.keys(record)).toEqual([]);
});

test('mesh start requires the transcript session it will attach to', async () => {
  const record: Record<string, Recorded> = {};
  const client = meshClient([], record);

  await expect(mesh.run({ ...ctx(['start', 'codex']), client })).rejects.toThrow();
  expect(record.start).toBeUndefined();
});

test('mesh start posts the agent, transcript, and resolved working path', async () => {
  const record: Record<string, Recorded> = {};
  const client = meshClient([], record);

  await captureStdout(() => mesh.run({ ...ctx(['start', 'codex'], { session: SESSION_ID, cwd: '.' }), client }));

  expect(record.start).toEqual({
    body: { transcriptTargetId: SESSION_ID, agentName: 'codex', workingPath: process.cwd() }
  });
});

test('mesh start refuses to spawn an agent that is not signed in', async () => {
  const record: Record<string, Recorded> = {};
  const client = meshClient([], record, 'unauthenticated');

  await expect(mesh.run({ ...ctx(['start', 'codex'], { session: SESSION_ID }), client })).rejects.toThrow(
    /not signed in/
  );
  expect(record.start).toBeUndefined();
});

test('an unknown sign-in state still starts — the probe is advisory, not a gate', async () => {
  const record: Record<string, Recorded> = {};
  const client = meshClient([], record, 'unknown');

  await captureStdout(() => mesh.run({ ...ctx(['start', 'codex'], { session: SESSION_ID }), client }));

  expect(record.start).toEqual({
    body: { transcriptTargetId: SESSION_ID, agentName: 'codex', workingPath: process.cwd() }
  });
});
