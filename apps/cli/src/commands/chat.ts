import type { MonadClient } from '@monad/client';
import type { SendMessageAttachment, SessionId } from '@monad/protocol';
import type { CommandDef } from './types.ts';

import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { getPaths } from '@monad/environment';

import { resolveAttachments } from '../lib/attachments.ts';
import { resolveText, streamReply } from '../lib/chat.ts';
import { t } from '../lib/i18n.ts';
import { idempotencyHeaders } from '../lib/idempotency.ts';
import { checkInitialized } from '../lib/init-flow.ts';
import { cyan, dim, json, out } from '../lib/output.ts';
import { requireTreatyData } from '../lib/treaty.ts';
import { CliError, EXIT } from './types.ts';

const REPL_EXIT = new Set(['/exit', '/quit']);

/**
 * Whether a REPL line leaves the session instead of being sent as a message.
 *
 * Client-side only: leaving is a property of this terminal, not of the conversation, and the daemon
 * registers neither name in its `/` namespace. Only the slash form counts — a bare `exit` is a
 * message someone may genuinely want to send to the agent.
 */
export function isReplExitCommand(line: string): boolean {
  return REPL_EXIT.has(line.trim().toLowerCase());
}

/** Load prior chat input lines (most-recent-first, for readline's history) — best-effort. */
async function loadHistory(path: string): Promise<string[]> {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean).reverse().slice(0, 500);
  } catch {
    return [];
  }
}

/** `headers` carries a replay key only for the one-shot path. The interactive loop deliberately
 *  passes none: repeating the same line in a REPL is a real second turn, not a retry. */
async function sendOnce(
  client: MonadClient,
  sessionId: SessionId,
  text: string,
  noStream: boolean,
  headers?: Record<string, string>,
  attachments?: SendMessageAttachment[]
): Promise<void> {
  const body = { text, ...(attachments ? { attachments } : {}) };
  if (noStream) {
    const message = requireTreatyData<{ message: { text: string } }>(
      await client.treaty.v1.sessions({ id: sessionId }).messages.block.post(body, headers ? { headers } : {})
    ).message;
    json({ sessionId, message });
    out(cyan('Monad ▸ ') + message.text);
    return;
  }
  await streamReply(client, sessionId, text, undefined, attachments);
}

// Flagship conversational entry. With a message it sends one turn and streams the reply; with no
// message on a TTY it opens an interactive loop. Resumes a session via --session, else creates one.
export const command: CommandDef = {
  name: 'chat',
  group: 'work',
  synopsis: 'chat [text|-] [--session <id>] [--file <path>] [--no-stream]',
  description: 'talk to your agent (streams the reply; interactive when given no message)',
  descriptionKey: 'cli.cmd.chat.desc',
  flags: {
    session: {
      type: 'string',
      alias: 's',
      description: 'resume an existing session id',
      descriptionKey: 'cli.chat.flag.session'
    },
    stream: {
      type: 'boolean',
      description: 'stream the reply token-by-token (default; --no-stream to disable)',
      descriptionKey: 'cli.chat.flag.stream'
    },
    file: {
      type: 'string',
      description: 'attach a local file; repeat for multiple',
      descriptionKey: 'cli.attach.flag.file'
    },
    'idempotency-key': {
      type: 'string',
      description: 'replay key for this write; derived from the request when omitted',
      descriptionKey: 'cli.flag.idempotencyKey'
    }
  },
  async run({ positionals, flags, client }) {
    if (!(await checkInitialized(client))) throw new CliError(t('cli.err.notInitialized'), EXIT.CONFIG);
    const noStream = flags.stream === false;
    let sessionId = (flags.session ?? flags.s) ? String(flags.session ?? flags.s) : undefined;
    if (!sessionId) {
      const title = positionals.join(' ').trim().slice(0, 40) || 'chat';
      sessionId = requireTreatyData<{ sessionId: string }>(
        await client.treaty.v1.sessions.post({ title }, { headers: idempotencyHeaders(flags, 'chat.new', [title]) })
      ).sessionId;
      json({ sessionId, created: true });
      out(dim(t('cli.chat.session', { id: sessionId })));
    }

    const text = await resolveText(positionals);
    const attachments = await resolveAttachments(flags.file);
    if (text || attachments) {
      await sendOnce(
        client,
        sessionId as SessionId,
        text,
        noStream,
        idempotencyHeaders(flags, 'chat.send', [sessionId, text, ...(attachments ?? []).map((a) => a.name)]),
        attachments
      );
      return;
    }

    // No message: interactive loop on a TTY; nothing to do otherwise.
    if (!process.stdin.isTTY) return;
    const histPath = join(getPaths().cache, 'chat_history');
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      history: await loadHistory(histPath),
      historySize: 500
    });
    out(dim(t('cli.chat.replHint')));

    // Ctrl-C aborts the in-flight reply (if streaming) or exits the REPL (if at the prompt).
    let streaming: AbortController | null = null;
    const onSigint = (): void => {
      if (streaming) {
        streaming.abort();
        streaming = null;
        out('');
      } else {
        out('');
        rl.close();
      }
    };
    process.on('SIGINT', onSigint);

    const loop = (): void => {
      rl.question(cyan(t('cli.chat.prompt')), async (line) => {
        // Lines starting with `/` are slash commands — they pass through as message text and the
        // daemon interprets them. `/exit` and `/quit` are the exception: they are client-side only,
        // and safe to claim because the daemon registers neither. The slash form is deliberate —
        // a bare `exit` is a message someone may genuinely want to send.
        const msg = line.trim();
        if (isReplExitCommand(msg)) {
          rl.close();
          return;
        }
        if (msg) {
          // Owner-only: this file accumulates every prompt the user has typed.
          void appendFile(histPath, `${msg}\n`, { mode: 0o600 }).catch(() => {});
          streaming = new AbortController();
          try {
            await streamReply(client, sessionId as SessionId, msg, streaming.signal);
          } finally {
            streaming = null;
          }
        }
        loop();
      });
    };
    loop();
    await new Promise<void>((resolve) => rl.on('close', resolve));
    process.off('SIGINT', onSigint);
  }
};
