import type { MonadClient } from '@monad/client';
import type {
  NativeAgentAttachmentInput,
  NativeAgentProjectAskRequest,
  NativeAgentProjectAskResponse
} from '@monad/protocol';

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { NATIVE_AGENT_ATTACHMENTS_MAX, NATIVE_AGENT_INLINE_TEXT_MAX, nanoid } from '@monad/protocol';

import { resolveText } from '../lib/chat.ts';
import { json, out } from '../lib/output.ts';
import { requireTreatyData } from '../lib/treaty.ts';
import { type CommandDef, usageError } from './types.ts';

function runtimeHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (Bun.env.MONAD_MESH_SESSION_ID) {
    headers['x-monad-mesh-session-id'] = Bun.env.MONAD_MESH_SESSION_ID;
  }
  return headers;
}

function print(data: unknown): void {
  json(data);
  out(JSON.stringify(data, null, 2));
}

function flagStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return value ? [String(value)] : [];
}

type TreatyPost<Body, Response> = {
  post: (
    body: Body,
    options?: { headers?: Record<string, string> }
  ) => Promise<{ data: Response | null; error: unknown; status: number }>;
};

function nativeAgentProjectAsk(client: MonadClient) {
  return client.treaty.v1.internal['native-agent']
    .project as (typeof client.treaty.v1.internal)['native-agent']['project'] & {
    ask: TreatyPost<NativeAgentProjectAskRequest, NativeAgentProjectAskResponse>;
  };
}

/** Build the wire body from the message text and an optional `--file` reference. Short text stays
 *  inline; text over the inline cap is spilled to a local file in the agent workspace and sent as a
 *  file attachment reference (the daemon registers the reference; content stays in the file). */
async function resolveMessageBody(
  text: string,
  fileFlag: unknown
): Promise<{ text?: string; attachments?: NativeAgentAttachmentInput[] }> {
  const attachments = flagStrings(fileFlag).map((file) => ({ path: resolve(file) }));
  if (attachments.length > NATIVE_AGENT_ATTACHMENTS_MAX) {
    throw usageError(`at most ${NATIVE_AGENT_ATTACHMENTS_MAX} --file attachments per message`);
  }
  if (text.length <= NATIVE_AGENT_INLINE_TEXT_MAX) {
    return { ...(text ? { text } : {}), ...(attachments.length ? { attachments } : {}) };
  }
  if (attachments.length >= NATIVE_AGENT_ATTACHMENTS_MAX) {
    throw usageError(
      'message text exceeds the inline limit and the attachment list is full; move the long content into one of the files'
    );
  }
  // Oversized text spills to a workspace file and rides along as an attachment. It goes FIRST so
  // the message preview (first text attachment) shows the actual message body, not a side file.
  const dir = join(process.cwd(), '.monad-attachments');
  await mkdir(dir, { recursive: true });
  // Keep spill files out of the project's VCS — they are message payloads, not source.
  await writeFile(join(dir, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => {});
  const path = join(dir, `message-${nanoid()}.md`);
  await writeFile(path, text, 'utf8');
  return { attachments: [{ path, name: 'long-message.md', mime: 'text/markdown' }, ...attachments] };
}

export const projectCommand: CommandDef = {
  name: 'project',
  synopsis: 'project <post|ask|read|inbox> [options]',
  description: 'post to or read the current Workplace Project room',
  flags: {
    thread: { type: 'string', description: 'project message id for threaded context' },
    before: { type: 'string', description: 'read messages before this message id' },
    after: { type: 'string', description: 'read messages after this message id' },
    around: { type: 'string', description: 'read messages around this message id' },
    limit: { type: 'number', description: 'maximum messages to read' },
    option: { type: 'string', description: 'choice option for project ask; repeat for multiple choices' },
    multi: { type: 'boolean', description: 'allow multiple choices for project ask' },
    other: { type: 'boolean', description: 'allow an Other free-text answer for project ask (default)' },
    file: { type: 'string', description: 'attach a local file (read-only reference for humans); repeat for multiple' }
  },
  async run({ positionals, flags, client }) {
    const [action, subaction, ...rest] = positionals;
    if (action === 'post') {
      const text = await resolveText([subaction, ...rest].filter((part): part is string => !!part));
      if (!text && !flags.file) throw usageError('usage: monad project post [--file <path> ...] <text|->');
      const body = await resolveMessageBody(text, flags.file);
      const data = requireTreatyData(
        await client.treaty.v1.internal['native-agent'].project.post.post(
          {
            threadId: flags.thread ? String(flags.thread) : undefined,
            ...body
          },
          { headers: runtimeHeaders() }
        )
      );
      print(data);
      return;
    }

    if (action === 'ask') {
      const question = await resolveText([subaction, ...rest].filter((part): part is string => !!part));
      if (!question)
        throw usageError('usage: monad project ask [--option <text> ...] [--multi] [--no-other] <question|->');
      const data = requireTreatyData(
        await nativeAgentProjectAsk(client).ask.post(
          {
            question,
            options: flagStrings(flags.option),
            mode: flags.multi === true ? 'multiple' : 'single',
            allowOther: flags.other !== false
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
            around: flags.around ? String(flags.around) : undefined,
            limit: typeof flags.limit === 'number' ? flags.limit : undefined
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

    throw usageError('usage: monad project <post|ask|read|inbox>');
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
    after: { type: 'string', description: 'read messages after this cursor' },
    file: { type: 'string', description: 'attach a local file (read-only reference for humans); repeat for multiple' }
  },
  async run({ positionals, flags, client }) {
    const [action, ...rest] = positionals;
    if (action === 'send') {
      const to = flags.to ? String(flags.to) : undefined;
      if (!to) throw usageError('usage: monad agent send --to <agent|human> [--file <path> ...] <text|->');
      const text = await resolveText(rest);
      if (!text && !flags.file)
        throw usageError('usage: monad agent send --to <agent|human> [--file <path> ...] <text|->');
      const body = await resolveMessageBody(text, flags.file);
      print(
        requireTreatyData(
          await client.treaty.v1.internal['native-agent'].agent.send.post(
            { to, ...body },
            { headers: runtimeHeaders() }
          )
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
  description: 'show the current managed MeshAgent runtime binding',
  async run({ positionals, client }) {
    if (positionals[0] !== 'info') throw usageError('usage: monad runtime info');
    print(
      requireTreatyData(await client.treaty.v1.internal['native-agent'].runtime.info.get({ headers: runtimeHeaders() }))
    );
  }
};
