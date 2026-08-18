import type { SessionId } from '@monad/protocol';
import type { SessionCommandDef } from './types.ts';

import { t } from '../../lib/i18n.ts';
import { dim, green, json, out } from '../../lib/output.ts';
import { requireTreatyData } from '../../lib/treaty.ts';
import { usageError } from '../types.ts';

export const command: SessionCommandDef = {
  name: 'archive',
  synopsis: 'archive <sessionId>',
  description: 'archive a session',
  descriptionKey: 'cli.session.archive.desc',
  async run({ positionals: args, client }) {
    const id = args[0];
    if (!id) throw usageError('usage: monad session archive <sessionId>');
    const { session } = requireTreatyData(
      await client.treaty.v1.sessions({ id: id as SessionId }).patch({ archived: true })
    );
    json(session);
    out(green(t('cli.updated')) + dim(`  ${id}`));
  }
};
