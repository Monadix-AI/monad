import type { SessionId } from '@monad/protocol';
import type { SessionCommandDef } from './types.ts';

import { t } from '../../lib/i18n.ts';
import { dim, green, json, out } from '../../lib/output.ts';
import { requireTreatyData } from '../../lib/treaty.ts';
import { usageError } from '../types.ts';

export const command: SessionCommandDef = {
  name: 'reset',
  synopsis: 'reset <sessionId>',
  description: 'clear all messages from a session, keeping the session itself',
  descriptionKey: 'cli.session.reset.desc',
  async run({ positionals: args, client }) {
    const id = args[0];
    if (!id) throw usageError('usage: monad session reset <sessionId>');
    const { clearedCount } = requireTreatyData(await client.treaty.v1.sessions({ id: id as SessionId }).reset.post());
    json({ clearedCount, sessionId: id });
    out(
      green(t('cli.session.reset.reset')) + dim(`  ${t('cli.session.reset.cleared', { count: clearedCount })}  ${id}`)
    );
  }
};
