import type { SessionId } from '@monad/protocol';
import type { SessionCommandDef } from './types.ts';

import { dim, green, out } from '../../lib/output.ts';
import { requireTreatyData } from '../../lib/treaty.ts';
import { usageError } from '../types.ts';

export const command: SessionCommandDef = {
  name: 'rm',
  aliases: ['delete'],
  synopsis: 'rm <sessionId>',
  description: 'delete a session and its data',
  descriptionKey: 'cli.session.rm.desc',
  async run({ positionals: args, client }) {
    const id = args[0];
    if (!id) throw usageError('usage: monad session rm <sessionId>');
    requireTreatyData(await client.treaty.v1.sessions({ id: id as SessionId }).delete());
    out(green('deleted') + dim(`  ${id}`));
  }
};
