import type { SearchMode } from '@monad/protocol';
import type { SessionCommandDef } from './types.ts';

import { t } from '../../lib/i18n.ts';
import { bold, cyan, dim, json, out } from '../../lib/output.ts';
import { requireTreatyData } from '../../lib/treaty.ts';
import { usageError } from '../types.ts';

const MODES: readonly SearchMode[] = ['keyword', 'semantic', 'hybrid'];

// search [--mode <m>] <query…> — search message history. Optional leading
// `--mode keyword|semantic|hybrid` flag; the rest is the query string.
export const command: SessionCommandDef = {
  name: 'search',
  synopsis: 'search [--mode <m>] <query>',
  description: 'search message history (keyword/semantic/hybrid)',
  descriptionKey: 'cli.session.search.desc',
  flags: { mode: { type: 'string', description: 'search mode: keyword | semantic | hybrid' } },
  async run({ positionals: args, flags, client }) {
    let mode: SearchMode | undefined;
    if (flags.mode !== undefined) {
      const m = String(flags.mode);
      if (!MODES.includes(m as SearchMode))
        throw new Error(t('cli.session.search.invalidMode', { modes: MODES.join(', ') }));
      mode = m as SearchMode;
    }
    const q = args.join(' ').trim();
    if (!q) throw usageError('usage: monad session search [--mode <m>] <query>');

    const { hits } = requireTreatyData(
      await client.treaty.v1.sessions.search.get({ query: { q, mode, limit: undefined } })
    );
    json(hits);
    if (hits.length === 0) {
      out(dim(t('cli.session.search.noMatches')));
      return;
    }
    for (const h of hits) {
      out(cyan(h.sessionId) + dim(`  ${h.matchedBy}  ${h.score.toFixed(3)}`));
      out(`  ${bold(h.transcriptTargetTitle)} ${dim(h.role)}  ${h.snippet}`);
    }
  }
};
