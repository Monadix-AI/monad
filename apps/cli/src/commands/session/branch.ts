import type { MessageId, SessionId } from '@monad/protocol';
import type { SessionCommandDef } from './types.ts';

import { cyan, json, out } from '../../lib/output.ts';
import { requireTreatyData } from '../../lib/treaty.ts';
import { usageError } from '../types.ts';

// branch <sessionId> [title] [atMessageId] — copy history into an independent session. Both extra args
// are optional; the daemon branches from the tip when no message id is given.
export const command: SessionCommandDef = {
  name: 'branch',
  synopsis: 'branch <sessionId> [title] [atMessageId]',
  description: 'copy session history into a new independent session',
  descriptionKey: 'cli.session.branch.desc',
  async run({ positionals: args, client }) {
    const [id, title, atMessageId] = args;
    if (!id) throw usageError('usage: monad session branch <sessionId> [title] [atMessageId]');
    const { sessionId } = requireTreatyData(
      await client.treaty.v1.sessions({ id: id as SessionId }).branch.post({
        title,
        atMessageId: atMessageId as MessageId | undefined
      })
    );
    json({ sessionId });
    out(cyan(sessionId));
  }
};
