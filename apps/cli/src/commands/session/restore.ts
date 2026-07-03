import type { MessageId, SessionId } from '@monad/protocol';
import type { SessionCommandDef } from './types.ts';

import { t } from '../../lib/i18n.ts';
import { dim, green, json, out } from '../../lib/output.ts';
import { requireTreatyData } from '../../lib/treaty.ts';
import { usageError } from '../types.ts';

export const command: SessionCommandDef = {
  name: 'restore',
  synopsis: 'restore <sessionId> <toMessageId>',
  description: 'rewind a session to a message checkpoint',
  descriptionKey: 'cli.session.restore.desc',
  async run({ positionals: args, client }) {
    const [id, toMessageId] = args;
    if (!id || !toMessageId) throw usageError('usage: monad session restore <sessionId> <toMessageId>');
    const { restoredCount, newHeadMessageId } = requireTreatyData(
      await client.treaty.v1.sessions({ id: id as SessionId }).restore.post({ toMessageId: toMessageId as MessageId })
    );
    json({ restoredCount, newHeadMessageId: newHeadMessageId ?? null });
    out(
      green(t('cli.session.restore.restored', { count: restoredCount })) +
        dim(`  ${t('cli.session.restore.head', { id: newHeadMessageId ?? t('cli.none') })}`)
    );
  }
};
