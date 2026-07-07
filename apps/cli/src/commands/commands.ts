import type { CommandDef } from './types.ts';

import { commandsListResponseSchema } from '@monad/protocol';

import { t } from '../lib/i18n.ts';
import { bold, cyan, dim, json, out } from '../lib/output.ts';

// The CLI equivalent of `/help`: list the unified slash-command set (built-ins + atom commands +
// user-invocable skills) the daemon advertises to every client.
export const command: CommandDef = {
  name: 'commands',
  synopsis: 'commands',
  description: 'list available slash commands (built-ins, atom commands, skills)',
  descriptionKey: 'cli.cmd.commands.desc',
  async run({ client }) {
    const res = await client.fetch('/v1/commands');
    if (!res.ok) throw new Error(`commands list failed: HTTP ${res.status}`);
    const { commands } = commandsListResponseSchema.parse(await res.json());
    json(commands);
    if (commands.length === 0) {
      out(dim(t('cli.commands.empty')));
      return;
    }
    const groups = [
      {
        label: t('cli.commands.group.builtin'),
        match: (c: (typeof commands)[number]) => c.type === 'action' && c.source === 'builtin'
      },
      {
        label: t('cli.commands.group.atom'),
        match: (c: (typeof commands)[number]) => c.type === 'action' && c.source === 'atom-pack'
      },
      { label: t('cli.commands.group.skills'), match: (c: (typeof commands)[number]) => c.type === 'skill' }
    ];
    for (const g of groups) {
      const rows = commands.filter(g.match);
      if (rows.length === 0) continue;
      out(bold(g.label));
      for (const c of rows) {
        const arg = c.argHint ? dim(` ${c.argHint}`) : '';
        const source = c.sourceName ? dim(`  (${c.sourceName})`) : '';
        out(`  ${cyan(`/${c.id}`)}${arg}  ${c.description}${source}`);
      }
    }
  }
};
