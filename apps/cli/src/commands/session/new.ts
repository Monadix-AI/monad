import type { SessionCommandDef } from './types.ts';

import { t } from '../../lib/i18n.ts';
import { cyan, dim, out } from '../../lib/output.ts';
import { requireTreatyData } from '../../lib/treaty.ts';
import { usageError } from '../types.ts';

export const command: SessionCommandDef = {
  name: 'new',
  aliases: ['create'],
  synopsis: 'new <title>',
  description: 'create a session, print its id',
  descriptionKey: 'cli.session.new.desc',
  async run({ positionals: args, client }) {
    const title = args[0];
    if (!title) throw usageError('usage: monad session new <title>');
    const id = requireTreatyData(await client.treaty.v1.sessions.post({ title })).sessionId;
    if (!id) throw new Error(t('cli.session.createFailed'));
    out(cyan(id) + dim(`  "${title}"`));
  }
};
