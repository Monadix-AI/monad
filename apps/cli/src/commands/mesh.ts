import type { SessionId } from '@monad/protocol';
import type { CommandContext, CommandDef } from './types.ts';

import { resolve } from 'node:path';
import { meshConvenienceFrameSchema, meshRawEventSchema, sessionIdSchema } from '@monad/protocol';

import { resolveText } from '../lib/chat.ts';
import { t } from '../lib/i18n.ts';
import { bold, cyan, dim, green, isStructured, json, out, red, yellow } from '../lib/output.ts';
import { renderTable } from '../lib/table.ts';
import { requireTreatyData } from '../lib/treaty.ts';
import { CliError, EXIT, usageError } from './types.ts';

type Client = CommandContext['client'];

/** Every per-session mesh route is scoped by the transcript it belongs to, so the id alone is not
 *  addressable — `--session` carries that scope. Looked up from the daemon-wide runtime list so a
 *  caller that only has a mesh session id never has to supply it by hand. */
async function scopeOf(client: Client, meshSessionId: string, flags: Record<string, unknown>): Promise<SessionId> {
  const explicit = flags.session;
  if (typeof explicit === 'string' && explicit) return sessionIdSchema.parse(explicit);
  const { sessions } = requireTreatyData(await client.treaty.v1.mesh.runtimes.get({ query: {} }));
  const match = sessions.find((session) => session.id === meshSessionId);
  if (!match) throw usageError(t('cli.mesh.scopeUnknown', { id: meshSessionId }));
  return match.sessionId;
}

function stateLabel(state: string): string {
  if (state === 'active' || state === 'connected') return green(state);
  if (state === 'terminal' || state === 'failed') return red(state);
  return yellow(state);
}

async function listRuntimes(client: Client): Promise<void> {
  const { sessions } = requireTreatyData(await client.treaty.v1.mesh.runtimes.get({ query: {} }));
  json(sessions);
  if (sessions.length === 0) {
    out(dim(t('cli.empty.meshSessions')));
    return;
  }
  out(
    renderTable(
      ['id', t('cli.mesh.col.agent'), t('cli.mesh.col.session'), t('cli.mesh.col.state'), t('cli.mesh.col.pending')],
      sessions.map((session) => [
        session.id,
        session.agentName,
        session.sessionId,
        `${session.lifecycle.state}/${session.activity.state}`,
        session.pendingApprovalCount ? String(session.pendingApprovalCount) : ''
      ])
    )
  );
}

async function listAgents(client: Client): Promise<void> {
  const { agents } = requireTreatyData(await client.treaty.v1.mesh.agents.get());
  json(agents);
  if (agents.length === 0) {
    out(dim(t('cli.empty.meshAgents')));
    return;
  }
  for (const agent of agents) {
    const state = agent.enabled ? green('●') : dim('○');
    out(`${state} ${bold(agent.name)}${dim(`  ${agent.provider}  ${agent.command}`)}`);
  }
}

async function show(client: Client, id: string | undefined, flags: Record<string, unknown>): Promise<void> {
  if (!id) throw usageError('usage: monad mesh show <meshSessionId> [--session <sessionId>]');
  const transcriptTargetId = await scopeOf(client, id, flags);
  const { session } = requireTreatyData(
    await client.treaty.v1.mesh.sessions({ id }).get({ query: { transcriptTargetId } })
  );
  json(session);
  out(bold(session.agentName) + dim(`  ${session.id}`));
  out(dim('  session:    ') + session.sessionId);
  out(dim('  workdir:    ') + session.workingPath);
  out(dim('  lifecycle:  ') + stateLabel(session.lifecycle.state));
  out(dim('  activity:   ') + stateLabel(session.activity.state));
  out(dim('  connection: ') + stateLabel(session.connection.state));
  if (session.pendingApprovalCount > 0) {
    out(yellow(`  ${t('cli.mesh.pendingApprovals', { count: session.pendingApprovalCount })}`));
  }
}

/** Report a provider CLI's sign-in state. Monad never brokers the sign-in itself: these agents are
 *  separate products with their own credentials, so proxying their login would mean handling
 *  someone else's secrets. We report the state and name the command the user runs themselves. */
async function authStatus(client: Client, agentName: string | undefined): Promise<void> {
  if (!agentName) throw usageError('usage: monad mesh auth <agentName>');
  const status = requireTreatyData(await client.treaty.v1.mesh.agents({ name: agentName }).auth.status.get());
  json(status);
  const label =
    status.state === 'authenticated'
      ? green(t('cli.mesh.auth.authenticated'))
      : status.state === 'unauthenticated'
        ? red(t('cli.mesh.auth.unauthenticated'))
        : yellow(t('cli.mesh.auth.unknown'));
  out(`${bold(status.agentName)}  ${label}${dim(`  ${status.provider}`)}`);
  if (status.state !== 'authenticated') out(dim(t('cli.mesh.auth.hint', { agent: status.agentName })));
  if (status.output.trim()) out(dim(status.output.trim()));
}

async function start(client: Client, agentName: string | undefined, flags: Record<string, unknown>): Promise<void> {
  const sessionRef = flags.session;
  if (!agentName || typeof sessionRef !== 'string' || !sessionRef) {
    throw usageError('usage: monad mesh start <agentName> --session <sessionId> [--cwd <path>]');
  }
  // Fail before spawning a runtime that would only sit at a login prompt. Advisory: an `unknown`
  // state (the provider exposes no probe) still starts.
  const { state } = requireTreatyData(await client.treaty.v1.mesh.agents({ name: agentName }).auth.status.get());
  if (state === 'unauthenticated') {
    throw new CliError(t('cli.mesh.auth.blocked', { agent: agentName }), EXIT.CONFIG);
  }
  const workingPath = typeof flags.cwd === 'string' && flags.cwd ? resolve(flags.cwd) : process.cwd();
  const { session } = requireTreatyData(
    await client.treaty.v1.mesh.sessions.post({
      transcriptTargetId: sessionIdSchema.parse(sessionRef),
      agentName,
      workingPath
    })
  );
  json(session);
  out(green(t('cli.mesh.started')) + dim('  ') + cyan(session.id) + dim(`  ${session.agentName}`));
}

/** `input` queues a turn; `steer` interrupts the current one with new direction. Same wire body. */
async function send(
  client: Client,
  verb: 'input' | 'steer',
  id: string | undefined,
  rest: string[],
  flags: Record<string, unknown>
): Promise<void> {
  if (!id) throw usageError(`usage: monad mesh ${verb} <meshSessionId> <text|->`);
  const input = await resolveText(rest);
  if (!input) throw usageError(`usage: monad mesh ${verb} <meshSessionId> <text|->`);
  const transcriptTargetId = await scopeOf(client, id, flags);
  const route = client.treaty.v1.mesh.sessions({ id });
  const result = verb === 'input' ? route.input : route.steer;
  requireTreatyData(await result.post({ input }, { query: { transcriptTargetId } }));
  out(green(t('cli.mesh.sent')) + dim(`  ${id}`));
}

async function signal(
  client: Client,
  verb: 'interrupt' | 'stop',
  id: string | undefined,
  flags: Record<string, unknown>
): Promise<void> {
  if (!id) throw usageError(`usage: monad mesh ${verb} <meshSessionId>`);
  const transcriptTargetId = await scopeOf(client, id, flags);
  const route = client.treaty.v1.mesh.sessions({ id });
  const endpoint = verb === 'interrupt' ? route.interrupt : route.stop;
  requireTreatyData(await endpoint.post(undefined, { query: { transcriptTargetId } }));
  out(green(verb === 'interrupt' ? t('cli.mesh.interrupted') : t('cli.mesh.stopped')) + dim(`  ${id}`));
}

/** Resolve one provider-owned approval a MeshAgent is blocked on. */
async function approve(
  client: Client,
  id: string | undefined,
  requestId: string | undefined,
  allow: boolean,
  flags: Record<string, unknown>
): Promise<void> {
  if (!id || !requestId) throw usageError('usage: monad mesh approve|deny <meshSessionId> <requestId>');
  const transcriptTargetId = await scopeOf(client, id, flags);
  requireTreatyData(
    await client.treaty.v1.mesh
      .sessions({ id })
      .approval.post(
        { requestId, allow, ...(typeof flags.reason === 'string' && flags.reason ? { reason: flags.reason } : {}) },
        { query: { transcriptTargetId } }
      )
  );
  out((allow ? green(t('cli.approval.allowed')) : red(t('cli.approval.denied'))) + dim(`  ${requestId}`));
}

/** No id → the daemon-wide provider overview; an id → that one runtime's token counters. */
async function usage(client: Client, id: string | undefined, flags: Record<string, unknown>): Promise<void> {
  if (id) {
    const transcriptTargetId = await scopeOf(client, id, flags);
    const { usage: counters } = requireTreatyData(
      await client.treaty.v1.mesh.sessions({ id }).usage.get({ query: { transcriptTargetId } })
    );
    json(counters);
    if (!counters) {
      out(dim(t('cli.mesh.noUsage')));
      return;
    }
    out(`${bold(String(counters.total))}${dim(t('cli.mesh.inOut', { in: counters.input, out: counters.output }))}`);
    return;
  }
  const overview = requireTreatyData(await client.treaty.v1.mesh.usage.get());
  json(overview);
  for (const provider of overview.providerUsage) {
    out(bold(provider.agentName) + dim(`  ${provider.provider}`));
    for (const record of provider.records) {
      const cap = record.max === undefined ? '' : dim(` / ${record.max}`);
      out(`  ${record.name}: ${record.current}${cap}`);
    }
  }
}

/** Follow a runtime's observation stream until Ctrl-C. The convenience plane is the default: it is
 *  the neutral projection every Monad surface renders. `--raw` switches to the verbatim provider
 *  frames, which is a diagnostic surface — same bytes the provider emitted, no normalization. */
async function watch(client: Client, id: string | undefined, flags: Record<string, unknown>): Promise<void> {
  if (!id) throw usageError('usage: monad mesh watch <meshSessionId> [--raw]');
  const transcriptTargetId = await scopeOf(client, id, flags);
  const raw = flags.raw === true;
  const path = `/v1/mesh/sessions/${encodeURIComponent(id)}/stream/${raw ? 'raw' : 'convenience'}?transcriptTargetId=${transcriptTargetId}`;
  if (!isStructured()) out(dim(t('cli.mesh.watching', { id })));

  const emit = (value: unknown): void => {
    if (isStructured()) {
      process.stdout.write(`${JSON.stringify(value)}\n`);
      return;
    }
    if (raw) {
      const frame = value as { stream?: string; data: unknown };
      const text = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
      process.stdout.write(frame.stream === 'stderr' ? red(text) : text);
      return;
    }
    const frame = value as { kind: string; reason?: string; operations?: Array<{ op: string; event?: unknown }> };
    if (frame.kind === 'unavailable') {
      out(yellow(t('cli.mesh.unavailable', { reason: frame.reason ?? '' })));
      return;
    }
    for (const operation of frame.operations ?? []) {
      if (operation.op !== 'upsert') continue;
      const event = operation.event as { kind: string; text?: string };
      out(dim(`${event.kind}  `) + (event.text ?? ''));
    }
  };

  const dispose = raw
    ? client.stream(path, meshRawEventSchema, emit, { resume: true, eventIdOf: (frame) => frame.cursor })
    : client.stream(path, meshConvenienceFrameSchema, emit, {
        resume: true,
        eventIdOf: (frame) => (frame.kind === 'patch' ? frame.cursor : undefined)
      });
  try {
    await new Promise<void>((resolve) => process.once('SIGINT', resolve));
  } finally {
    dispose();
  }
}

// The MeshAgent runtime: native CLI agents (codex, claude, …) running as team members under a
// transcript. The daemon has driven this from the web UI only; these verbs make a team scriptable.
export const command: CommandDef = {
  name: 'mesh',
  group: 'work',
  synopsis: 'mesh <list|agents|auth|show|watch|start|input|steer|interrupt|stop|approve|deny|usage> [arg]',
  subcommands: [
    'list',
    'agents',
    'auth',
    'show',
    'watch',
    'start',
    'input',
    'steer',
    'interrupt',
    'stop',
    'approve',
    'deny',
    'usage'
  ],
  description: 'drive MeshAgent runtimes (native CLI agents running as team members)',
  descriptionKey: 'cli.cmd.mesh.desc',
  flags: {
    session: {
      type: 'string',
      description: 'transcript session id the mesh session belongs to',
      descriptionKey: 'cli.mesh.flag.session'
    },
    cwd: { type: 'string', description: 'working directory for mesh start', descriptionKey: 'cli.mesh.flag.cwd' },
    reason: { type: 'string', description: 'reason recorded with an approval', descriptionKey: 'cli.mesh.flag.reason' },
    raw: {
      type: 'boolean',
      description: 'watch the verbatim provider frames instead of the neutral projection',
      descriptionKey: 'cli.mesh.flag.raw'
    }
  },
  async run({ positionals, flags, client }) {
    const [action = 'list', id, ...rest] = positionals;
    switch (action) {
      case 'list':
      case 'ls':
        return listRuntimes(client);
      case 'agents':
        return listAgents(client);
      case 'show':
      case 'get':
        return show(client, id, flags);
      case 'start':
        return start(client, id, flags);
      case 'input':
      case 'steer':
        return send(client, action, id, rest, flags);
      case 'interrupt':
      case 'stop':
        return signal(client, action, id, flags);
      case 'approve':
        return approve(client, id, rest[0], true, flags);
      case 'deny':
        return approve(client, id, rest[0], false, flags);
      case 'watch':
      case 'tail':
        return watch(client, id, flags);
      case 'auth':
        return authStatus(client, id);
      case 'usage':
        return usage(client, id, flags);
      default:
        throw usageError(t('cli.mesh.unknownAction', { action }));
    }
  }
};
