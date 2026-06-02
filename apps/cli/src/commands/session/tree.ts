import type { SessionId } from '@monad/protocol';
import type { SessionCommandDef } from './types.ts';

import { cyan, dim, json, out } from '../../lib/output.ts';
import { requireTreatyData } from '../../lib/treaty.ts';
import { usageError } from '../types.ts';

export const command: SessionCommandDef = {
  name: 'tree',
  aliases: ['provenance', 'lineage'],
  synopsis: 'tree <sessionId>',
  description: 'show a session lineage (ancestors / self / descendants)',
  descriptionKey: 'cli.session.tree.desc',
  async run({ positionals: args, client }) {
    const id = args[0];
    if (!id) throw usageError('usage: monad session tree <sessionId>');
    const result = requireTreatyData(await client.treaty.v1.sessions({ id: id as SessionId }).provenance.get());
    json(result);
    const { ancestors, self, descendants } = result;
    out(dim('ancestors   ') + (ancestors.map((s) => s.id).join(' → ') || dim('none')));
    out(`${cyan('self        ')}${self.id}  ${self.title}`);
    out(dim('descendants ') + (descendants.map((s) => s.id).join(', ') || dim('none')));
  }
};
