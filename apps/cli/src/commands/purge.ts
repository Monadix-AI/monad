import type { CommandDef } from './types.ts';

import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { getPaths, initMonadHome } from '@monad/environment';

import { stopDaemon } from '../lib/daemon.ts';
import { t } from '../lib/i18n.ts';
import { bold, dim, green, json, out, red, yellow } from '../lib/output.ts';
import { purgeAuth, purgeConfig, purgeSessions } from './purge/scopes.ts';
import { usageError } from './types.ts';

const SCOPES = ['sessions', 'config', 'auth', 'all'] as const;
type Scope = (typeof SCOPES)[number];

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    })
  );
}

async function purgeAll(yes: boolean): Promise<void> {
  const paths = getPaths();

  // Under XDG the layout spans several roots; under the single tree these all collapse to `home`.
  // dirname(paths.logs) = stateRoot on XDG ($XDG_STATE_HOME/monad), home on single-tree.
  const roots = [...new Set([paths.home, paths.configs, paths.cache, dirname(paths.logs), paths.runtime])];

  // --yes / --no-input skips the interactive double-confirm (for scripted teardown).
  if (!yes) {
    out(`${red(bold('WARNING'))}  ${t('cli.purge.warning')}`);
    for (const root of roots) out(dim(`  ${root}`));
    out(dim(t('cli.purge.lost')));
    out('');

    if ((await ask(t('cli.purge.confirm1'))) !== 'purge') {
      out(yellow(t('cli.aborted')));
      return;
    }
    if (!/^y$/i.test(await ask(t('cli.purge.confirm2')))) {
      out(yellow(t('cli.aborted')));
      return;
    }
  }

  await stopDaemon();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  await initMonadHome(paths);
  json({ purged: 'all', roots });
  out(green(t('cli.purge.done')));
  out(dim(t('cli.purge.restartHint')));
}

// One destructive noun. Narrow scopes back up what they remove first; `all` wipes and rebuilds the
// whole home and is the only scope that double-confirms. Distinct from `session reset <id>`, which
// clears one session's messages and leaves the home alone.
export const command: CommandDef = {
  local: true,
  name: 'purge',
  group: 'configure',
  synopsis: 'purge <sessions|config|auth|all> [--keep-last <n>]',
  subcommands: ['sessions', 'config', 'auth', 'all'],
  description: 'permanently delete stored state (sessions, config, auth, or all of Monad home)',
  descriptionKey: 'cli.cmd.purge.desc',
  flags: {
    'keep-last': {
      type: 'number',
      description: 'for "sessions": keep this many most-recent sessions',
      descriptionKey: 'cli.cmd.purge.keepLastFlag'
    }
  },
  async run({ positionals, flags, globals }) {
    const scope = positionals[0] as Scope | undefined;
    if (!scope) {
      out(t('cli.subcommands'));
      for (const s of SCOPES) out(dim(`  monad purge ${s}`));
      return;
    }
    if (!SCOPES.includes(scope)) throw usageError(t('cli.purge.unknownScope', { scope, list: SCOPES.join(', ') }));

    switch (scope) {
      case 'sessions':
        return purgeSessions((flags['keep-last'] as number | undefined) ?? 0, globals.yes);
      case 'config':
        return purgeConfig(globals.yes);
      case 'auth':
        return purgeAuth(globals.yes);
      case 'all':
        return purgeAll(globals.yes);
    }
  }
};
