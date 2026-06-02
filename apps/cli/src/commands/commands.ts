import type { CommandDef } from './types.ts';

import { t } from '../lib/i18n.ts';
import { bold, cyan, dim, json, out } from '../lib/output.ts';
import { requireTreatyData } from '../lib/treaty.ts';

// The CLI equivalent of `/help`: list the unified slash-command set (built-ins + atom commands +
// user-invocable skills) the daemon advertises to every client.
export const command: CommandDef = {
  name: 'commands',
  synopsis: 'commands',
  description: 'list available slash commands (built-ins, atom commands, skills)',
  descriptionKey: 'cli.cmd.commands.desc',
  async run({ client }) {
    const { commands } = requireTreatyData(await client.treaty.v1.commands.get());
    json(commands);
    if (commands.length === 0) {
      out(dim(t('cli.commands.empty')));
      return;
    }
    const groups = [
      { label: t('cli.commands.group.builtin'), match: (c: (typeof commands)[number]) => c.source === 'builtin' },
      { label: t('cli.commands.group.atom'), match: (c: (typeof commands)[number]) => c.source === 'atom' },
      { label: t('cli.commands.group.skills'), match: (c: (typeof commands)[number]) => c.kind === 'prompt' }
    ];
    for (const g of groups) {
      const rows = commands.filter(g.match);
      if (rows.length === 0) continue;
      out(bold(g.label));
      for (const c of rows) {
        const arg = c.argHint ? dim(` ${c.argHint}`) : '';
        const atom = c.atomName ? dim(`  (${c.atomName})`) : '';
        out(`  ${cyan(`/${c.name}`)}${arg}  ${c.description}${atom}`);
      }
    }
  }
};
