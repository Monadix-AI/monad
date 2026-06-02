import type { SessionId } from '@monad/protocol';
import type { SessionCommandDef } from './types.ts';

import { json, page } from '../../lib/output.ts';
import { requireTreatyData } from '../../lib/treaty.ts';
import { usageError } from '../types.ts';

export const command: SessionCommandDef = {
  name: 'show',
  aliases: ['get'],
  synopsis: 'show <sessionId>',
  description: 'show one session as JSON',
  descriptionKey: 'cli.session.show.desc',
  async run({ positionals: args, client }) {
    const id = args[0];
    if (!id) throw usageError('usage: monad session show <sessionId>');
    const { session } = requireTreatyData(await client.treaty.v1.sessions({ id: id as SessionId }).get());
    json(session);
    await page(JSON.stringify(session, null, 2));
  }
};
