import type { SessionId } from '@monad/protocol';
import type { SessionCommandDef } from './types.ts';

import { resolveText, streamReply } from '../../lib/chat.ts';
import { t } from '../../lib/i18n.ts';
import { cyan, dim, green, out } from '../../lib/output.ts';
import { requireTreatyData } from '../../lib/treaty.ts';
import { usageError } from '../types.ts';

// Consolidated send: stream the reply by default; --no-stream prints the full reply in one shot;
// --detach posts the turn fire-and-forget. Text of `-` (or a pipe) is read from stdin.
export const command: SessionCommandDef = {
  name: 'send',
  synopsis: 'send <sessionId> <text|-> [--no-stream] [--detach]',
  description: 'send a message (streams the reply; --no-stream for full reply, --detach to fire-and-forget)',
  descriptionKey: 'cli.session.send.desc',
  flags: {
    stream: { type: 'boolean', description: 'stream the reply token-by-token (default; --no-stream to disable)' },
    detach: { type: 'boolean', description: 'post the turn without waiting for a reply' }
  },
  async run({ positionals: args, flags, client }) {
    const [sessionId, ...rest] = args;
    if (!sessionId) throw usageError('usage: monad session send <sessionId> <text|->');
    const text = await resolveText(rest);
    if (!text) throw usageError('usage: monad session send <sessionId> <text|->');

    if (flags.detach === true) {
      await client.treaty.v1.sessions({ id: sessionId as SessionId }).messages.post({ text });
      out(green(t('cli.session.send.sent')) + dim(`  → ${sessionId}`));
      return;
    }

    if (flags.stream === false) {
      const message = requireTreatyData<{ message: { text: string } }>(
        await client.treaty.v1.sessions({ id: sessionId as SessionId }).messages.block.post({ text })
      ).message;
      out(cyan('Monad ▸ ') + message.text);
      return;
    }

    const ac = new AbortController();
    const onSigint = (): void => {
      ac.abort();
      out('');
    };
    process.once('SIGINT', onSigint);
    try {
      await streamReply(client, sessionId as SessionId, text, ac.signal);
    } finally {
      process.off('SIGINT', onSigint);
    }
    out(dim(t('cli.session.send.done')));
  }
};
