import type { MessageId, SessionId } from '@monad/protocol';
import type { SessionCommandDef } from './types.ts';

import { t } from '../../lib/i18n.ts';
import { bold, cyan, dim, isStructured, json, out, page } from '../../lib/output.ts';
import { requireTreatyData } from '../../lib/treaty.ts';
import { usageError } from '../types.ts';

function roleColor(role: string): string {
  return role === 'assistant' ? cyan(role) : role === 'user' ? bold(role) : dim(role);
}

// The read side of a transcript. `session watch` only sees events published while it is attached
// and `session show` returns metadata, so without this a `--detach` turn could be sent but never
// read back.
export const command: SessionCommandDef = {
  name: 'messages',
  aliases: ['history'],
  synopsis: 'messages <sessionId> [--limit <n>] [--before <messageId>] [--include-inactive]',
  description: "read a session's transcript, newest page last",
  descriptionKey: 'cli.session.messages.desc',
  flags: {
    limit: { type: 'number', description: 'maximum messages to return', descriptionKey: 'cli.session.messages.limit' },
    before: {
      type: 'string',
      description: 'page backwards from this message id',
      descriptionKey: 'cli.session.messages.before'
    },
    'include-inactive': {
      type: 'boolean',
      description: 'include messages hidden by a restore or branch',
      descriptionKey: 'cli.session.messages.includeInactive'
    }
  },
  async run({ positionals: args, flags, client }) {
    const id = args[0];
    if (!id) throw usageError('usage: monad session messages <sessionId> [--limit <n>] [--before <messageId>]');
    const limit = typeof flags.limit === 'number' ? flags.limit : undefined;
    const before = typeof flags.before === 'string' && flags.before ? (flags.before as MessageId) : undefined;
    const result = requireTreatyData(
      await client.treaty.v1.sessions({ id: id as SessionId }).messages.get({
        query: {
          limit,
          before,
          includeInactive: flags['include-inactive'] === true ? true : undefined
        }
      })
    );
    json(result);
    if (isStructured()) return;
    if (result.messages.length === 0) {
      out(dim(t('cli.session.messages.empty')));
      return;
    }
    const body = result.messages
      .map((message) => {
        const inactive = message.active ? '' : dim(t('cli.session.messages.inactive'));
        return `${roleColor(message.role)}${inactive}${dim(`  ${message.createdAt}  ${message.id}`)}\n${message.text}`;
      })
      .join('\n\n');
    await page(body);
    if (result.nextCursor) out(dim(t('cli.session.messages.more', { cursor: result.nextCursor })));
  }
};
