import type { SessionCommandDef } from './types.ts';

import { t } from '../../lib/i18n.ts';
import { idempotencyHeaders } from '../../lib/idempotency.ts';
import { cyan, dim, json, out } from '../../lib/output.ts';
import { requireTreatyData } from '../../lib/treaty.ts';
import { usageError } from '../types.ts';

export const command: SessionCommandDef = {
  name: 'new',
  aliases: ['create'],
  synopsis: 'new <title>',
  description: 'create a session, print its id',
  descriptionKey: 'cli.session.new.desc',
  flags: {
    'idempotency-key': {
      type: 'string',
      description: 'replay key for this write; derived from the request when omitted',
      descriptionKey: 'cli.flag.idempotencyKey'
    }
  },
  async run({ positionals: args, flags, client }) {
    const title = args[0];
    if (!title) throw usageError('usage: monad session new <title>');
    const id = requireTreatyData(
      await client.treaty.v1.sessions.post({ title }, { headers: idempotencyHeaders(flags, 'session.new', [title]) })
    ).sessionId;
    if (!id) throw new Error(t('cli.session.createFailed'));
    json({ sessionId: id, title });
    out(cyan(id) + dim(`  "${title}"`));
  }
};
