import type { MonadClient } from '@monad/client';
import type { SessionId } from '@monad/protocol';
import type { CommandDef } from './types.ts';

import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { getPaths } from '@monad/environment';

import { resolveText, streamReply } from '../lib/chat.ts';
import { t } from '../lib/i18n.ts';
import { cyan, dim, out } from '../lib/output.ts';
import { requireTreatyData } from '../lib/treaty.ts';

/** Load prior chat input lines (most-recent-first, for readline's history) — best-effort. */
async function loadHistory(path: string): Promise<string[]> {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean).reverse().slice(0, 500);
  } catch {
    return [];
  }
}

async function sendOnce(client: MonadClient, sessionId: SessionId, text: string, noStream: boolean): Promise<void> {
  if (noStream) {
    const message = requireTreatyData<{ message: { text: string } }>(
      await client.treaty.v1.sessions({ id: sessionId }).messages.block.post({ text })
    ).message;
    out(cyan('Monad ▸ ') + message.text);
    return;
  }
  await streamReply(client, sessionId, text);
}

// Flagship conversational entry. With a message it sends one turn and streams the reply; with no
// message on a TTY it opens an interactive loop. Resumes a session via --session, else creates one.
export const command: CommandDef = {
  name: 'chat',
  synopsis: 'chat [text|-] [--session <id>] [--no-stream]',
  description: 'talk to your agent (streams the reply; interactive when given no message)',
  descriptionKey: 'cli.cmd.chat.desc',
  flags: {
    session: { type: 'string', alias: 's', description: 'resume an existing session id' },
    stream: { type: 'boolean', description: 'stream the reply token-by-token (default; --no-stream to disable)' }
  },
  async run({ positionals, flags, client }) {
    const noStream = flags.stream === false;
    let sessionId = (flags.session ?? flags.s) ? String(flags.session ?? flags.s) : undefined;
    if (!sessionId) {
      const title = positionals.join(' ').trim().slice(0, 40) || 'chat';
      sessionId = requireTreatyData<{ sessionId: string }>(await client.treaty.v1.sessions.post({ title })).sessionId;
      out(dim(t('cli.chat.session', { id: sessionId })));
    }

    const text = await resolveText(positionals);
    if (text) {
      await sendOnce(client, sessionId as SessionId, text, noStream);
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
        // daemon interprets them, so no special handling is needed here.
        const msg = line.trim();
        if (msg) {
          void appendFile(histPath, `${msg}\n`).catch(() => {});
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
