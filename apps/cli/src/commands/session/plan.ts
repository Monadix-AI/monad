import type {
  IdempotencyKey,
  SessionId,
  SessionPlan,
  SessionPlanTodo,
  SessionPlanTodoId,
  SessionPlanTodoStatus
} from '@monad/protocol';
import type { CommandContext, FlagSpec } from '../types.ts';
import type { SessionCommandDef } from './types.ts';

import { idempotencyKeySchema, newId, sessionPlanTodoStatusSchema } from '@monad/protocol';

import { resolveText } from '../../lib/chat.ts';
import { t } from '../../lib/i18n.ts';
import { bold, cyan, dim, green, json, out, red, yellow } from '../../lib/output.ts';
import { renderTable } from '../../lib/table.ts';
import { CliError, EXIT, usageError } from '../types.ts';

// `session plan` is a thin Treaty client over the human/operator plan surface (@monad/client, no RTK).
// Mutations carry a fresh idempotency key per invocation and the expected version the caller read, so the
// daemon's compare-and-swap rejects a stale write with a 409 the caller can recover from.
type PlanTreatyResult<T> = { data: T | Response | null; error?: unknown; status: number };

function planErrorDetail(error: unknown): string {
  if (error && typeof error === 'object') {
    const value = (error as { value?: unknown }).value;
    if (value && typeof value === 'object') {
      const record = value as { error?: unknown; code?: unknown };
      if (typeof record.error === 'string') return record.error;
      if (typeof record.code === 'string') return record.code;
    }
  }
  return '';
}

// Map the plan surface's documented status codes to a recoverable, localized CLI error. 409 is the CAS
// conflict the caller retries after re-reading; 404/403/400 are terminal for this invocation.
function requirePlan<T>(result: PlanTreatyResult<T>, sessionId: string): Exclude<T, Response> {
  if (result.data !== null && !(result.data instanceof Response)) return result.data as Exclude<T, Response>;
  const detail = planErrorDetail(result.error);
  const suffix = detail ? `: ${detail}` : '';
  if (result.status === 409) throw new CliError(t('cli.session.plan.err.conflict', { sessionId }), EXIT.ERROR);
  if (result.status === 404) throw new CliError(t('cli.session.plan.err.notFound') + suffix, EXIT.ERROR);
  if (result.status === 403) throw new CliError(t('cli.session.plan.err.forbidden') + suffix, EXIT.ERROR);
  if (result.status === 400) throw new CliError(t('cli.session.plan.err.invalid') + suffix, EXIT.ERROR);
  throw new CliError(`${t('cli.session.plan.err.failed')} (${result.status})${suffix}`, EXIT.ERROR);
}

function parseStatus(flags: Record<string, unknown>): SessionPlanTodoStatus | undefined {
  if (flags.status === undefined) return undefined;
  const parsed = sessionPlanTodoStatusSchema.safeParse(String(flags.status));
  if (!parsed.success) throw usageError(t('cli.session.plan.err.badStatus', { status: String(flags.status) }));
  return parsed.data;
}

// A mutation reuses an explicit `--request-id` so a lost-response retry replays the same daemon mutation
// instead of creating a duplicate; absent one, a fresh key is minted. The key is validated before the call.
function resolveRequestId(flags: Record<string, unknown>): IdempotencyKey {
  const raw = flags['request-id'] ?? flags.requestId;
  if (raw === undefined) return newId('idem');
  const parsed = idempotencyKeySchema.safeParse(String(raw));
  if (!parsed.success) throw usageError(t('cli.session.plan.err.badRequestId'));
  return parsed.data;
}

function parseExpectedVersion(raw: string | undefined): number {
  const version = Number(raw);
  if (raw === undefined || !Number.isInteger(version) || version < 0) {
    throw usageError(t('cli.session.plan.err.badVersion'));
  }
  return version;
}

function colorStatus(status: SessionPlanTodoStatus): string {
  if (status === 'completed') return green(status);
  if (status === 'in_progress') return yellow(status);
  return dim(status);
}

function renderPlan(plan: SessionPlan): void {
  json(plan);
  if (plan.todos.length === 0) {
    out(dim(t('cli.session.plan.empty')));
    return;
  }
  // renderTable requires plain cells (widths); status color is applied only in the single-line receipts.
  const rows = plan.todos.map((todo) => [
    todo.id,
    String(todo.version),
    todo.status,
    todo.assigneeProjectMemberId ?? '—',
    todo.text
  ]);
  out(
    renderTable(
      [
        t('cli.session.plan.header.id'),
        t('cli.session.plan.header.version'),
        t('cli.session.plan.header.status'),
        t('cli.session.plan.header.assignee'),
        t('cli.session.plan.header.text')
      ],
      rows
    )
  );
}

function printTodo(todo: SessionPlanTodo, verb: 'added' | 'updated'): void {
  json({ todo });
  const key = verb === 'added' ? 'cli.session.plan.added' : 'cli.session.plan.updated';
  out(`${green(t(key))}  ${cyan(todo.id)}  ${colorStatus(todo.status)}  v${todo.version}`);
}

async function planList({ positionals, client }: CommandContext): Promise<void> {
  const [id] = positionals;
  if (!id) throw usageError('usage: monad session plan list <sessionId>');
  const plan = requirePlan(await client.treaty.v1.sessions({ id: id as SessionId }).plan.get(), id).plan;
  renderPlan(plan);
}

async function planAdd({ positionals, flags, client }: CommandContext): Promise<void> {
  const [id, ...rest] = positionals;
  if (!id) throw usageError('usage: monad session plan add <sessionId> <text|-> [--status s] [--assignee pmid]');
  const text = await resolveText(rest);
  if (!text) throw usageError('usage: monad session plan add <sessionId> <text|-> [--status s] [--assignee pmid]');
  const status = parseStatus(flags);
  const assignee = flags.assignee !== undefined ? String(flags.assignee) : undefined;
  const { todo } = requirePlan(
    await client.treaty.v1.sessions({ id: id as SessionId }).plan.todos.post({
      requestId: resolveRequestId(flags),
      text,
      ...(status ? { status } : {}),
      ...(assignee ? { assigneeProjectMemberId: assignee } : {})
    }),
    id
  );
  printTodo(todo, 'added');
}

async function planUpdate({ positionals, flags, client }: CommandContext): Promise<void> {
  const [id, todoId, versionArg] = positionals;
  if (!id || !todoId) {
    throw usageError(
      'usage: monad session plan update <sessionId> <todoId> <expectedVersion> [--text|--status|--assignee|--unassign]'
    );
  }
  const expectedVersion = parseExpectedVersion(versionArg);
  const status = parseStatus(flags);
  const text = flags.text !== undefined ? String(flags.text) : undefined;
  const unassign = flags.unassign === true;
  const assignee = flags.assignee !== undefined ? String(flags.assignee) : undefined;
  if (unassign && assignee !== undefined) throw usageError(t('cli.session.plan.err.assignConflict'));

  const patch: { text?: string; status?: SessionPlanTodoStatus; assigneeProjectMemberId?: string | null } = {};
  if (text !== undefined) patch.text = text;
  if (status) patch.status = status;
  if (unassign) patch.assigneeProjectMemberId = null;
  else if (assignee !== undefined) patch.assigneeProjectMemberId = assignee;
  if (Object.keys(patch).length === 0) throw usageError(t('cli.session.plan.err.emptyPatch'));

  const { todo } = requirePlan(
    await client.treaty.v1
      .sessions({ id: id as SessionId })
      .plan.todos({ todoId: todoId as SessionPlanTodoId })
      .patch({ requestId: resolveRequestId(flags), expectedVersion, patch }),
    id
  );
  printTodo(todo, 'updated');
}

async function planRemove({ positionals, flags, client }: CommandContext): Promise<void> {
  const [id, todoId, versionArg] = positionals;
  if (!id || !todoId) throw usageError('usage: monad session plan rm <sessionId> <todoId> <expectedVersion>');
  const expectedVersion = parseExpectedVersion(versionArg);
  const removed = requirePlan(
    await client.treaty.v1
      .sessions({ id: id as SessionId })
      .plan.todos({ todoId: todoId as SessionPlanTodoId })
      .delete({ requestId: resolveRequestId(flags), expectedVersion }),
    id
  );
  json(removed);
  out(`${red(t('cli.session.plan.removed'))}  ${cyan(removed.todoId)}`);
}

const verbs: Record<string, (ctx: CommandContext) => Promise<void>> = {
  list: planList,
  ls: planList,
  add: planAdd,
  update: planUpdate,
  set: planUpdate,
  rm: planRemove,
  remove: planRemove,
  delete: planRemove
};

const planFlags: Record<string, FlagSpec> = {
  status: { type: 'string', description: 'to-do status', descriptionKey: 'cli.session.plan.flag.status' },
  assignee: {
    type: 'string',
    description: 'assign by projectMemberId',
    descriptionKey: 'cli.session.plan.flag.assignee'
  },
  unassign: { type: 'boolean', description: 'clear the assignee', descriptionKey: 'cli.session.plan.flag.unassign' },
  text: { type: 'string', description: 'new to-do text', descriptionKey: 'cli.session.plan.flag.text' },
  'request-id': {
    type: 'string',
    description: 'reuse an idempotency key',
    descriptionKey: 'cli.session.plan.flag.requestId'
  }
};

// `monad session plan --help` reaches this via the session subHelp hook; `main.ts` renders one synopsis
// line per subcommand, so a grouped command lists its own verbs and flags here (syntax literal, copy
// localized — same split the usage lines use).
function renderPlanHelp(): string {
  const col = 48;
  const verbLine = (syntax: string, key: string): string => `  ${bold(syntax.padEnd(col))}${t(key)}`;
  const flagLine = (head: string, key: string): string => `  ${bold(head.padEnd(col))}${t(key)}`;
  return [
    bold('monad session plan <list|add|update|rm> <sessionId> …'),
    '',
    t('cli.session.plan.desc'),
    '',
    bold('Subcommands:'),
    verbLine('list <sessionId>', 'cli.session.plan.help.list'),
    verbLine('add <sessionId> <text|->', 'cli.session.plan.help.add'),
    verbLine('update <sessionId> <todoId> <expectedVersion>', 'cli.session.plan.help.update'),
    verbLine('rm <sessionId> <todoId> <expectedVersion>', 'cli.session.plan.help.rm'),
    '',
    bold('Flags:'),
    flagLine('--status <pending|in_progress|completed>', 'cli.session.plan.flag.status'),
    flagLine('--assignee <projectMemberId>', 'cli.session.plan.flag.assignee'),
    flagLine('--unassign', 'cli.session.plan.flag.unassign'),
    flagLine('--text <text>', 'cli.session.plan.flag.text'),
    flagLine('--request-id <idem_…>', 'cli.session.plan.flag.requestId')
  ].join('\n');
}

export const command: SessionCommandDef = {
  name: 'plan',
  synopsis: 'plan <list|add|update|rm> <sessionId> …',
  description: 'view and edit the shared durable session to-do plan',
  descriptionKey: 'cli.session.plan.desc',
  flags: planFlags,
  help: renderPlanHelp,
  async run(ctx) {
    const [verb, ...rest] = ctx.positionals;
    const handler = verb ? verbs[verb] : undefined;
    if (!handler) {
      throw usageError('usage: monad session plan <list|add|update|rm> <sessionId> …');
    }
    await handler({ ...ctx, positionals: rest });
  }
};
