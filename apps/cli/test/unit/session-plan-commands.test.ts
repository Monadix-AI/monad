import { expect, test } from 'bun:test';

import { renderSessionSubHelp } from '../../src/commands/session/index.ts';
import { command as plan } from '../../src/commands/session/plan.ts';
import { CliError, type CommandContext, EXIT } from '../../src/commands/types.ts';
import { runDev } from '../../src/dev.ts';

function ctx(positionals: string[], flags: Record<string, unknown>, client: unknown): CommandContext {
  return {
    positionals,
    flags,
    globals: { json: false, quiet: false, verbose: 0, yes: false, color: false },
    client: client as CommandContext['client']
  };
}

async function capture(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    chunks.push(typeof s === 'string' ? s : new TextDecoder().decode(s));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join('');
}

function ok<T>(data: T) {
  return { data, status: 200 };
}

function todo(overrides: Record<string, unknown> = {}) {
  return {
    id: 'todo_aaa000000001',
    sessionId: 'ses_plan00000001',
    text: 'ship the wire',
    status: 'pending',
    version: 0,
    createdBy: { source: { surface: 'cli', client: 'monad-cli', transport: 'http' } },
    updatedBy: { source: { surface: 'cli', client: 'monad-cli', transport: 'http' } },
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    ...overrides
  };
}

// A treaty double for the human/operator plan surface: sessions({id}).plan.get / .plan.todos.post /
// .plan.todos({todoId}).patch / .delete — the exact paths @monad/client exposes.
function planClient(routes: {
  get?: (params: { id: string }) => unknown;
  post?: (params: { id: string }, body: Record<string, unknown>) => unknown;
  patch?: (params: { id: string }, todo: { todoId: string }, body: Record<string, unknown>) => unknown;
  del?: (params: { id: string }, todo: { todoId: string }, body: Record<string, unknown>) => unknown;
}) {
  return {
    treaty: {
      v1: {
        sessions: (params: { id: string }) => ({
          plan: {
            get: async () => routes.get?.(params) ?? ok({ plan: { sessionId: params.id, todos: [] } }),
            todos: Object.assign(
              (todoParams: { todoId: string }) => ({
                patch: async (body: Record<string, unknown>) =>
                  routes.patch?.(params, todoParams, body) ?? ok({ todo: todo() }),
                delete: async (body: Record<string, unknown>) =>
                  routes.del?.(params, todoParams, body) ?? ok({ deleted: true, todoId: todoParams.todoId })
              }),
              { post: async (body: Record<string, unknown>) => routes.post?.(params, body) ?? ok({ todo: todo() }) }
            )
          }
        })
      }
    }
  };
}

const IDEM = /^idem_[0-9a-zA-Z]{12}$/;

test('session plan list: reads the addressed session and renders each todo row', async () => {
  let addressed = '';
  const client = planClient({
    get: (params) => {
      addressed = params.id;
      return ok({
        plan: {
          sessionId: params.id,
          todos: [todo({ id: 'todo_row000000001', status: 'in_progress', version: 3, text: 'wire the fence' })]
        }
      });
    }
  });
  const output = await capture(() => plan.run(ctx(['list', 'ses_plan00000001'], {}, client)));
  expect(addressed).toBe('ses_plan00000001');
  // Row cells are the raw todo fields (headers are the only i18n text and are asserted elsewhere).
  for (const cell of ['todo_row000000001', '3', 'in_progress', 'wire the fence']) expect(output).toContain(cell);
});

test('session plan list: empty plan shows the empty-state guidance and no rows', async () => {
  const client = planClient({ get: (params) => ok({ plan: { sessionId: params.id, todos: [] } }) });
  const output = await capture(() => plan.run(ctx(['list', 'ses_plan00000001'], {}, client)));
  expect(output).toContain('No to-dos');
  expect(output).not.toContain('todo_');
});

test('session plan add: forwards a generated idempotency key, text, and optional status/assignee', async () => {
  let sent: Record<string, unknown> | undefined;
  const client = planClient({
    post: (_params, body) => {
      sent = body;
      return ok({ todo: todo({ id: 'todo_new000000001', status: 'in_progress' }) });
    }
  });
  const output = await capture(() =>
    plan.run(
      ctx(['add', 'ses_plan00000001', 'buy milk'], { status: 'in_progress', assignee: 'pmem_builder0001' }, client)
    )
  );
  expect(sent).toEqual({
    requestId: expect.stringMatching(IDEM),
    text: 'buy milk',
    status: 'in_progress',
    assigneeProjectMemberId: 'pmem_builder0001'
  });
  expect(output).toContain('todo_new000000001');
});

test('session plan add: joins multi-word text and omits unset optional fields', async () => {
  let sent: Record<string, unknown> | undefined;
  const client = planClient({
    post: (_params, body) => {
      sent = body;
      return ok({ todo: todo() });
    }
  });
  await capture(() => plan.run(ctx(['add', 'ses_plan00000001', 'buy', 'oat', 'milk'], {}, client)));
  expect(sent).toEqual({ requestId: expect.stringMatching(IDEM), text: 'buy oat milk' });
});

test('session plan add: missing text is a usage error', async () => {
  const client = planClient({});
  await expect(capture(() => plan.run(ctx(['add', 'ses_plan00000001'], {}, client)))).rejects.toBeInstanceOf(CliError);
});

test('session plan update: sends the todo id, expected version, and only the changed fields', async () => {
  let seen: { todoId: string; body: Record<string, unknown> } | undefined;
  const client = planClient({
    patch: (_params, todoParams, body) => {
      seen = { todoId: todoParams.todoId, body };
      return ok({ todo: todo({ status: 'completed', version: 3 }) });
    }
  });
  await capture(() =>
    plan.run(ctx(['update', 'ses_plan00000001', 'todo_aaa000000001', '2'], { status: 'completed' }, client))
  );
  expect(seen?.todoId).toBe('todo_aaa000000001');
  expect(seen?.body).toEqual({
    requestId: expect.stringMatching(IDEM),
    expectedVersion: 2,
    patch: { status: 'completed' }
  });
});

test('session plan update: --unassign clears the assignee as an explicit null in the patch', async () => {
  let body: Record<string, unknown> | undefined;
  const client = planClient({
    patch: (_p, _t, sent) => {
      body = sent;
      return ok({ todo: todo() });
    }
  });
  await capture(() =>
    plan.run(ctx(['update', 'ses_plan00000001', 'todo_aaa000000001', '1'], { unassign: true }, client))
  );
  expect(body?.patch).toEqual({ assigneeProjectMemberId: null });
});

test('session plan update: no field flags is a usage error (empty patch)', async () => {
  const client = planClient({});
  await expect(
    capture(() => plan.run(ctx(['update', 'ses_plan00000001', 'todo_aaa000000001', '1'], {}, client)))
  ).rejects.toBeInstanceOf(CliError);
});

test('session plan update: --assignee together with --unassign is a usage error', async () => {
  const client = planClient({});
  await expect(
    capture(() =>
      plan.run(
        ctx(['update', 'ses_plan00000001', 'todo_aaa000000001', '1'], { assignee: 'pmem_x', unassign: true }, client)
      )
    )
  ).rejects.toBeInstanceOf(CliError);
});

test('session plan update: a non-integer expected version is a usage error before any request', async () => {
  let calls = 0;
  const client = planClient({
    patch: () => {
      calls++;
      return ok({ todo: todo() });
    }
  });
  await expect(
    capture(() =>
      plan.run(ctx(['update', 'ses_plan00000001', 'todo_aaa000000001', 'notanumber'], { status: 'completed' }, client))
    )
  ).rejects.toBeInstanceOf(CliError);
  expect(calls).toBe(0);
});

test('session plan update: an invalid status is a usage error before any request', async () => {
  let calls = 0;
  const client = planClient({
    patch: () => {
      calls++;
      return ok({ todo: todo() });
    }
  });
  await expect(
    capture(() => plan.run(ctx(['update', 'ses_plan00000001', 'todo_aaa000000001', '1'], { status: 'done' }, client)))
  ).rejects.toBeInstanceOf(CliError);
  expect(calls).toBe(0);
});

test('session plan rm: sends the expected version and prints the deletion receipt', async () => {
  let body: Record<string, unknown> | undefined;
  const client = planClient({
    del: (_p, todoParams, sent) => {
      body = sent;
      return ok({ deleted: true, todoId: todoParams.todoId });
    }
  });
  const output = await capture(() => plan.run(ctx(['rm', 'ses_plan00000001', 'todo_aaa000000001', '5'], {}, client)));
  expect(body).toEqual({ requestId: expect.stringMatching(IDEM), expectedVersion: 5 });
  expect(output).toContain('todo_aaa000000001');
});

test('session plan: a 409 version conflict surfaces as a recoverable CLI error', async () => {
  const client = planClient({
    patch: () => ({
      data: null,
      error: { value: { code: 'SESSION_PLAN_VERSION_CONFLICT', error: 'expected version 2 but current is 3' } },
      status: 409
    })
  });
  const err = await plan
    .run(ctx(['update', 'ses_plan00000001', 'todo_aaa000000001', '2'], { status: 'completed' }, client))
    .then(() => undefined)
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CliError);
  expect((err as CliError).code).toBe(EXIT.ERROR);
  // Recoverable: names the retry path and interpolates the addressed session id.
  expect((err as CliError).message).toContain('retry');
  expect((err as CliError).message).toContain('ses_plan00000001');
});

test('session plan: an unknown verb is a usage error', async () => {
  const client = planClient({});
  const err = await plan
    .run(ctx(['bogus', 'ses_plan00000001'], {}, client))
    .then(() => undefined)
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CliError);
  expect((err as CliError).code).toBe(EXIT.USAGE);
});

// ── I1: reusable idempotency key ─────────────────────────────────────────────────

test('session plan add: an explicit --request-id is forwarded verbatim', async () => {
  let sent: Record<string, unknown> | undefined;
  const client = planClient({
    post: (_p, body) => {
      sent = body;
      return ok({ todo: todo() });
    }
  });
  await capture(() => plan.run(ctx(['add', 'ses_plan00000001', 'hi'], { 'request-id': 'idem_explicit0001' }, client)));
  expect(sent?.requestId).toBe('idem_explicit0001');
});

test('session plan: an invalid --request-id is rejected before any request', async () => {
  let calls = 0;
  const client = planClient({
    post: () => {
      calls++;
      return ok({ todo: todo() });
    }
  });
  const err = await plan
    .run(ctx(['add', 'ses_plan00000001', 'hi'], { 'request-id': 'not-an-idem-key' }, client))
    .then(() => undefined)
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CliError);
  expect((err as CliError).code).toBe(EXIT.USAGE);
  expect(calls).toBe(0);
});

test('session plan add: reusing the same --request-id lands the mutation exactly once (lost-response retry)', async () => {
  // Stateful fake mirroring the daemon idempotency ledger: a seen requestId replays without re-committing.
  const ledger = new Map<string, { todo: ReturnType<typeof todo> }>();
  let created = 0;
  const client = planClient({
    post: (_p, body) => {
      const key = String(body.requestId);
      let entry = ledger.get(key);
      if (!entry) {
        created++;
        entry = { todo: todo({ id: 'todo_once00000001' }) };
        ledger.set(key, entry);
      }
      return ok(entry);
    }
  });
  const flags = { 'request-id': 'idem_retry0000001' };
  await capture(() => plan.run(ctx(['add', 'ses_plan00000001', 'buy milk'], flags, client)));
  await capture(() => plan.run(ctx(['add', 'ses_plan00000001', 'buy milk'], flags, client)));
  expect(created).toBe(1);
});

test('session plan add: the same --request-id with a changed payload surfaces the daemon idempotency conflict', async () => {
  const ledger = new Map<string, string>();
  const client = planClient({
    post: (_p, body) => {
      const key = String(body.requestId);
      const fingerprint = String(body.text);
      const seen = ledger.get(key);
      if (seen !== undefined && seen !== fingerprint) {
        return { data: null, error: { value: { code: 'SESSION_PLAN_IDEMPOTENCY_CONFLICT' } }, status: 409 };
      }
      ledger.set(key, fingerprint);
      return ok({ todo: todo() });
    }
  });
  const flags = { 'request-id': 'idem_reuse0000001' };
  await capture(() => plan.run(ctx(['add', 'ses_plan00000001', 'first'], flags, client)));
  const err = await plan
    .run(ctx(['add', 'ses_plan00000001', 'second'], flags, client))
    .then(() => undefined)
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CliError);
  expect((err as CliError).code).toBe(EXIT.ERROR);
});

// ── I2: reachable localized help ─────────────────────────────────────────────────

test('session sub-help resolves the plan subcommand to its full verb/flag help', () => {
  const help = renderSessionSubHelp(['plan']);
  for (const token of ['add', 'update', 'rm', '--status', '--request-id', 'in_progress']) {
    expect(help).toContain(token);
  }
});

test('monad session plan --help renders the plan help from the CLI surface and exits 0', async () => {
  const originalArgv = process.argv;
  process.argv = [process.argv[0] ?? 'bun', 'dev.ts', 'session', 'plan', '--help'];
  let code: number | undefined;
  const output = await capture(async () => {
    code = await runDev();
  });
  process.argv = originalArgv;
  expect(code).toBe(0);
  for (const token of ['add <sessionId>', 'update <sessionId>', 'rm <sessionId>', '--status', '--request-id']) {
    expect(output).toContain(token);
  }
});
