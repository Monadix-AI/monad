import type { CommandDef } from './types.ts';

import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { getPaths, initMonadHome } from '@monad/environment';

import { stopDaemon } from '../lib/daemon.ts';
import { t } from '../lib/i18n.ts';
import { bold, dim, green, out, red, yellow } from '../lib/output.ts';

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    })
  );
}

export const command: CommandDef = {
  local: true,
  name: 'purge',
  synopsis: 'purge',
  description: 'wipe and rebuild Monad home (destructive — requires double confirmation)',
  descriptionKey: 'cli.cmd.purge.desc',
  async run({ globals }) {
    const paths = getPaths();

    // Under XDG the layout spans several roots; under the single tree these all collapse to `home`.
    // dirname(paths.logs) = stateRoot on XDG ($XDG_STATE_HOME/monad), home on single-tree.
    const roots = [...new Set([paths.home, paths.configs, paths.cache, dirname(paths.logs), paths.runtime])];

    // --yes / --no-input skips the interactive double-confirm (for scripted teardown).
    if (!globals.yes) {
      out(`${red(bold('WARNING'))}  ${t('cli.reset.warning')}`);
      for (const r of roots) out(dim(`  ${r}`));
      out(dim(t('cli.reset.lost')));
      out('');

      const first = await ask(t('cli.reset.confirm1'));
      if (first !== 'reset') {
        out(yellow(t('cli.aborted')));
        return;
      }

      const second = await ask(t('cli.reset.confirm2'));
      if (!/^y$/i.test(second)) {
        out(yellow(t('cli.aborted')));
        return;
      }
    }

    await stopDaemon();
    for (const root of roots) await rm(root, { recursive: true, force: true });
    await initMonadHome(paths);
    out(green(t('cli.reset.done')));
    out(dim(t('cli.reset.restartHint')));
  }
};
