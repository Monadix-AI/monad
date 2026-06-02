import type { SessionId, SessionState } from '@monad/protocol';
import type { SessionCommandDef } from './types.ts';

import { t } from '../../lib/i18n.ts';
import { dim, json, out, yellow } from '../../lib/output.ts';
import { renderTable } from '../../lib/table.ts';
import { requireTreatyData } from '../../lib/treaty.ts';

/** Server-side cap on `sessions.attention.list` (listSessionAttentionQuerySchema). */
const ATTENTION_BATCH = 200;

export const command: SessionCommandDef = {
  name: 'list',
  aliases: ['ls'],
  synopsis: 'list [state] [--limit <n>] [--offset <n>] [--attention]',
  description: 'list sessions, optionally filtered by state',
  descriptionKey: 'cli.session.list.desc',
  flags: {
    limit: {
      type: 'number',
      description: 'maximum sessions to return',
      descriptionKey: 'cli.session.list.limitFlag'
    },
    offset: {
      type: 'number',
      description: 'skip this many sessions',
      descriptionKey: 'cli.session.list.offsetFlag'
    },
    attention: {
      type: 'boolean',
      description: 'only sessions waiting on a human, with what they need',
      descriptionKey: 'cli.session.list.attentionFlag'
    }
  },
  async run({ positionals: args, flags, client }) {
    const state = args[0] as SessionState | undefined;
    const { sessions } = requireTreatyData(
      await client.treaty.v1.sessions.get({
        query: {
          archived: undefined,
          limit: typeof flags.limit === 'number' ? flags.limit : undefined,
          offset: typeof flags.offset === 'number' ? flags.offset : undefined,
          ...(state ? { state } : {})
        }
      })
    );

    // The attention projection is a separate lookup keyed by session id (capped at 200 per call), so
    // it is only fetched when asked for. A null `state` means nothing is waiting on that session.
    if (flags.attention === true) {
      // The attention projection accepts at most 200 ids per call, so a long-lived daemon needs
      // several. Paging rather than truncating: a silently dropped tail reads as "nothing is
      // waiting", which is the one answer this flag must never get wrong.
      const batches: SessionId[][] = [];
      for (let index = 0; index < sessions.length; index += ATTENTION_BATCH) {
        batches.push(sessions.slice(index, index + ATTENTION_BATCH).map((session) => session.id));
      }
      const pages = await Promise.all(
        batches.map((sessionIds) =>
          client.treaty.v1.sessions.attention.get({ query: { sessionIds } }).then(requireTreatyData)
        )
      );
      const summaries = pages.flatMap((page) => page.summaries).filter((summary) => summary.state !== null);
      json(summaries);
      if (summaries.length === 0) {
        out(dim(t('cli.session.list.noAttention')));
        return;
      }
      const titleOf = new Map(sessions.map((s) => [s.id, s.title]));
      out(
        renderTable(
          [t('cli.session.list.headerSession'), t('cli.session.list.headerTitle'), t('cli.session.list.headerNeeds')],
          summaries.map((summary) => [
            summary.sessionId,
            titleOf.get(summary.sessionId) ?? '',
            yellow(summary.state ?? '')
          ])
        )
      );
      return;
    }

    json(sessions);
    if (sessions.length === 0) {
      out(dim(t('cli.session.list.empty')));
      return;
    }
    const rows = sessions.map((s) => [
      s.id,
      s.title,
      [s.state, s.archived ? 'archived' : null].filter(Boolean).join(' ')
    ]);
    out(
      renderTable(
        [t('cli.session.list.headerSession'), t('cli.session.list.headerTitle'), t('cli.session.list.headerState')],
        rows
      )
    );
  }
};
