import type { CommandContext } from '../types.ts';
import type { SessionCommandDef } from './types.ts';

import { t } from '../../lib/i18n.ts';
import { checkInitialized } from '../../lib/init-flow.ts';
import { bold, dim } from '../../lib/output.ts';
import { CliError, EXIT } from '../types.ts';
import { command as abort } from './abort.ts';
import { command as branch } from './branch.ts';
import { command as list } from './list.ts';
import { command as newCmd } from './new.ts';
import { command as reset } from './reset.ts';
import { command as restore } from './restore.ts';
import { command as rm } from './rm.ts';
import { command as search } from './search.ts';
import { command as send } from './send.ts';
import { command as show } from './show.ts';
import { command as watch } from './watch.ts';

const sessionCommands: SessionCommandDef[] = [
  newCmd,
  list,
  show,
  send,
  watch,
  search,
  branch,
  restore,
  reset,
  abort,
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
    return `  ${bold(c.synopsis.padEnd(colWidth))}${desc}${aliasHint}`;
  });
  return [`${bold('monad session')} <subcommand>`, '', `${bold(t('cli.subcommands'))}`, ...rows].join('\n');
}

/** English snapshot for tests; live throws call buildSessionUsage() fresh (post-init, localized). */
const _SESSION_USAGE_TEXT = buildSessionUsage();

export async function runSessionCommand(ctx: CommandContext): Promise<void> {
  const [subcommand, ...subArgs] = ctx.positionals;
  const cmd = subcommand ? registry.get(subcommand) : undefined;
  if (!cmd) throw new CliError(buildSessionUsage(), EXIT.USAGE);
  if (!(await checkInitialized(ctx.client))) throw new CliError(t('cli.err.notInitialized'), EXIT.ERROR);
  await cmd.run({ ...ctx, positionals: subArgs });
}
