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
        groupBuiltins: true,
        label: t('cli.commands.group.builtin'),
        match: (c: (typeof commands)[number]) => c.type === 'action' && c.source === 'builtin'
      },
      {
        groupBuiltins: false,
        label: t('cli.commands.group.atom'),
        match: (c: (typeof commands)[number]) => c.type === 'action' && c.source === 'atom-pack'
      },
      {
        groupBuiltins: false,
        label: t('cli.commands.group.skills'),
        match: (c: (typeof commands)[number]) => c.type === 'skill'
      }
    ];
    for (const g of groups) {
      const rows = commands.filter(g.match);
      if (rows.length === 0) continue;
      out(bold(g.label));
      const renderedRows = g.groupBuiltins ? sortCommandsByGroup(rows) : rows;
      let previousGroup: string | undefined;
      for (const c of renderedRows) {
        if (c.source === 'builtin' && c.group && c.group !== previousGroup) {
          previousGroup = c.group;
          out(dim(`  ${commandGroupLabel(c.group)}`));
        }
        const arg = c.argHint ? dim(` ${c.argHint}`) : '';
        const source = c.sourceName ? dim(`  (${c.sourceName})`) : '';
        out(`  ${cyan(`/${c.id}`)}${arg}  ${c.description}${source}`);
        for (const subcommand of c.subcommands ?? []) {
          const subArg = subcommand.args?.length ? dim(` ${commandArgsHint(subcommand.args)}`) : '';
          const shortcut = subcommand.shortcut ? dim(`  shortcut /${subcommand.shortcut}`) : '';
          out(`    ${cyan(`/${c.id} ${subcommand.id}`)}${subArg}  ${subcommand.description}${shortcut}`);
        }
      }
    }
  }
};

const COMMAND_GROUP_ORDER = ['Conversation', 'Context', 'Memory', 'Runtime', 'Help'];

function sortCommandsByGroup<T extends { group?: string; name: string; id: string }>(commands: T[]): T[] {
  return commands.toSorted(
    (a, b) =>
      commandGroupRank(a.group) - commandGroupRank(b.group) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  );
}

function commandGroupRank(group: string | undefined): number {
  if (!group) return COMMAND_GROUP_ORDER.length;
  const rank = COMMAND_GROUP_ORDER.indexOf(group);
  return rank === -1 ? COMMAND_GROUP_ORDER.length : rank;
}

function commandGroupLabel(group: string): string {
  const key = group.charAt(0).toLowerCase() + group.slice(1);
  const translated = t(`cmd.help.group.${key}`);
  return translated === `cmd.help.group.${key}` ? group : translated;
}

function commandArgsHint(args: Array<{ name: string; placeholder?: string; required?: boolean }>): string {
  return args.map((arg) => arg.placeholder ?? (arg.required ? `<${arg.name}>` : `[${arg.name}]`)).join(' ');
}
