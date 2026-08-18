import type { CommandContext } from '../types.ts';
import type { SessionCommandDef } from './types.ts';

import { t } from '../../lib/i18n.ts';
import { checkInitialized } from '../../lib/init-flow.ts';
import { bold, cyan, dim, green } from '../../lib/output.ts';
import { CliError, EXIT, FLAG_COL } from '../types.ts';
import { command as abort } from './abort.ts';
import { command as archive } from './archive.ts';
import { command as branch } from './branch.ts';
import { command as list } from './list.ts';
import { command as messages } from './messages.ts';
import { command as newCmd } from './new.ts';
import { command as plan } from './plan.ts';
import { command as reset } from './reset.ts';
import { command as restore } from './restore.ts';
import { command as rm } from './rm.ts';
import { command as search } from './search.ts';
import { command as send } from './send.ts';
import { command as show } from './show.ts';
import { command as unarchive } from './unarchive.ts';
import { command as watch } from './watch.ts';

const sessionCommands: SessionCommandDef[] = [
  newCmd,
  list,
  show,
  messages,
  send,
  watch,
  search,
  plan,
  branch,
  restore,
  reset,
  abort,
  archive,
  unarchive,
  rm
];

const registry = new Map(
  sessionCommands.flatMap((c) => [[c.name, c], ...(c.aliases ?? []).map((a) => [a, c] as const)])
);

function buildSessionUsage(): string {
  const colWidth = Math.max(...sessionCommands.map((c) => c.synopsis.length)) + 2;
  const rows = sessionCommands.map((c) => {
    const aliasHint = c.aliases?.length ? dim(`  (${c.aliases.join(', ')})`) : '';
    const desc = c.descriptionKey ? t(c.descriptionKey) : c.description;
    const separator = c.synopsis.indexOf(' ');
    const name = separator === -1 ? c.synopsis : c.synopsis.slice(0, separator);
    const args = separator === -1 ? '' : c.synopsis.slice(separator);
    const padding = ' '.repeat(colWidth - c.synopsis.length);
    return `  ${bold(green(name))}${cyan(args)}${padding}${desc}${aliasHint}`;
  });
  return [`${bold('monad session')} ${cyan('<subcommand>')}`, '', `${bold(cyan(t('cli.subcommands')))}`, ...rows].join(
    '\n'
  );
}

/** Localized help for one session subcommand — the sub's own `help()` when it has verbs/flags of its
 *  own (e.g. `plan`), else its synopsis, description, aliases, and declared flags. Reached via
 *  `monad session <sub> --help`. Mirrors the top-level renderer so a subcommand's flags are as
 *  discoverable as a top-level command's. */
export function renderSessionSubHelp(args: string[]): string | undefined {
  const sub = args[0] ? registry.get(args[0]) : undefined;
  if (!sub) return undefined;
  if (sub.help) return sub.help();
  const lines = [
    `${bold('monad session')} ${bold(green(sub.name))}${cyan(sub.synopsis.slice(sub.name.length))}`,
    '',
    sub.descriptionKey ? t(sub.descriptionKey) : sub.description
  ];
  if (sub.aliases?.length) lines.push('', `${dim('aliases:')} ${sub.aliases.join(', ')}`);
  const flagEntries = Object.entries(sub.flags ?? {});
  if (flagEntries.length) {
    lines.push('', bold(cyan(t('cli.usage.flags'))));
    for (const [name, spec] of flagEntries) {
      const head = `${spec.alias ? `-${spec.alias}, ` : ''}--${name}`;
      lines.push(
        `  ${bold(cyan(head.padEnd(FLAG_COL)))}${spec.descriptionKey ? t(spec.descriptionKey) : spec.description}`
      );
    }
  }
  return lines.join('\n');
}

export async function runSessionCommand(ctx: CommandContext): Promise<void> {
  const [subcommand, ...subArgs] = ctx.positionals;
  const cmd = subcommand ? registry.get(subcommand) : undefined;
  if (!cmd) throw new CliError(buildSessionUsage(), EXIT.USAGE);
  if (!(await checkInitialized(ctx.client))) throw new CliError(t('cli.err.notInitialized'), EXIT.ERROR);
  await cmd.run({ ...ctx, positionals: subArgs });
}
