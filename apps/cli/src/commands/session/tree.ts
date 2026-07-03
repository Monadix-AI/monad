import type { SessionId } from '@monad/protocol';
import type { SessionCommandDef } from './types.ts';

import { t } from '../../lib/i18n.ts';
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
    out(dim(t('cli.session.tree.ancestors')) + (ancestors.map((s) => s.id).join(' → ') || dim(t('cli.none'))));
    out(`${cyan(t('cli.session.tree.self'))}${self.id}  ${self.title}`);
    out(dim(t('cli.session.tree.descendants')) + (descendants.map((s) => s.id).join(', ') || dim(t('cli.none'))));
  }
};
