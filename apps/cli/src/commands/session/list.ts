import type { SessionState } from '@monad/protocol';
import type { SessionCommandDef } from './types.ts';

import { dim, json, out } from '../../lib/output.ts';
import { renderTable } from '../../lib/table.ts';
import { requireTreatyData } from '../../lib/treaty.ts';

export const command: SessionCommandDef = {
  name: 'list',
  aliases: ['ls'],
  synopsis: 'list [state]',
  description: 'list sessions, optionally filtered by state',
  descriptionKey: 'cli.session.list.desc',
  async run({ positionals: args, client }) {
    const state = args[0] as SessionState | undefined;
    const { sessions } = requireTreatyData(
      await client.treaty.v1.sessions.get({
        query: { archived: undefined, limit: undefined, offset: undefined, ...(state ? { state } : {}) }
      })
    );
    json(sessions);
    if (sessions.length === 0) {
      out(dim('no sessions'));
      return;
    }
    const rows = sessions.map((s) => [
      s.id,
      s.title,
      [s.state, s.archived ? 'archived' : null].filter(Boolean).join(' ')
    ]);
    out(renderTable(['SESSION', 'TITLE', 'STATE'], rows));
  }
};
