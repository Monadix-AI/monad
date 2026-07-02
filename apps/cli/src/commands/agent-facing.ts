import { resolveText } from '../lib/chat.ts';
import { json, out } from '../lib/output.ts';
import { requireTreatyData } from '../lib/treaty.ts';
import { type CommandDef, usageError } from './types.ts';

function runtimeHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (Bun.env.MONAD_NATIVE_CLI_SESSION_ID) {
    headers['x-monad-native-cli-session-id'] = Bun.env.MONAD_NATIVE_CLI_SESSION_ID;
  }
  return headers;
}

function print(data: unknown): void {
  json(data);
  out(JSON.stringify(data, null, 2));
}

export const projectCommand: CommandDef = {
  name: 'project',
  synopsis: 'project <post|read|inbox> [options]',
  description: 'post to or read the current Workplace Project room',
  flags: {
    thread: { type: 'string', description: 'project message id for threaded context' },
    before: { type: 'string', description: 'read messages before this message id' },
    after: { type: 'string', description: 'read messages after this message id' },
    around: { type: 'string', description: 'read messages around this message id' }
  },
  async run({ positionals, flags, client }) {
    const [action, subaction, ...rest] = positionals;
    if (action === 'post') {
      const text = await resolveText([subaction, ...rest].filter((part): part is string => !!part));
      if (!text) throw usageError('usage: monad project post <text|->');
      const data = requireTreatyData(
        await client.treaty.v1.internal['native-agent'].project.post.post(
          {
            threadId: flags.thread ? String(flags.thread) : undefined,
            text
          },
          { headers: runtimeHeaders() }
        )
      );
      print(data);
      return;
    }

    if (action === 'read') {
      const data = requireTreatyData(
        await client.treaty.v1.internal['native-agent'].project.read.post(
          {
            threadId: flags.thread ? String(flags.thread) : undefined,
            before: flags.before ? String(flags.before) : undefined,
            after: flags.after ? String(flags.after) : undefined,
            around: flags.around ? String(flags.around) : undefined
          },
          { headers: runtimeHeaders() }
        )
      );
      print(data);
      return;
    }

    if (action === 'inbox' && (subaction === undefined || subaction === 'check')) {
      const data = requireTreatyData(
        await client.treaty.v1.internal['native-agent'].project.inbox.post({}, { headers: runtimeHeaders() })
      );
      print(data);
      return;
    }

    if (action === 'inbox' && subaction === 'ack') {
      const data = requireTreatyData(
        await client.treaty.v1.internal['native-agent'].project.inbox.ack.post({}, { headers: runtimeHeaders() })
      );
      print(data);
      return;
    }

    throw usageError('usage: monad project <post|read|inbox>');
  }
};

export const agentCommand: CommandDef = {
  name: 'agent',
  synopsis: 'agent <send|read> [options]',
  description: 'send or read direct private messages with a Monad agent or human',
  flags: {
    to: { type: 'string', description: 'direct message recipient for send' },
    with: { type: 'string', description: 'direct conversation peer for read' },
    before: { type: 'string', description: 'read messages before this cursor' },
    after: { type: 'string', description: 'read messages after this cursor' }
  },
  async run({ positionals, flags, client }) {
    const [action, ...rest] = positionals;
    if (action === 'send') {
      const to = flags.to ? String(flags.to) : undefined;
      if (!to) throw usageError('usage: monad agent send --to <agent|human> <text|->');
      const text = await resolveText(rest);
      if (!text) throw usageError('usage: monad agent send --to <agent|human> <text|->');
      print(
        requireTreatyData(
          await client.treaty.v1.internal['native-agent'].agent.send.post({ to, text }, { headers: runtimeHeaders() })
        )
      );
      return;
    }

    if (action === 'read') {
      const peer = flags.with ? String(flags.with) : undefined;
      if (!peer) throw usageError('usage: monad agent read --with <agent|human>');
      print(
        requireTreatyData(
          await client.treaty.v1.internal['native-agent'].agent.read.post(
            {
              with: peer,
              before: flags.before ? String(flags.before) : undefined,
              after: flags.after ? String(flags.after) : undefined
            },
            { headers: runtimeHeaders() }
          )
        )
      );
      return;
    }

    throw usageError('usage: monad agent <send|read>');
  }
};

export const runtimeCommand: CommandDef = {
  name: 'runtime',
  synopsis: 'runtime info',
  description: 'show the current managed native CLI runtime binding',
  async run({ positionals, client }) {
    if (positionals[0] !== 'info') throw usageError('usage: monad runtime info');
    print(
      requireTreatyData(await client.treaty.v1.internal['native-agent'].runtime.info.get({ headers: runtimeHeaders() }))
    );
  }
};
