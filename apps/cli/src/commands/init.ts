import type { CommandDef } from './types.ts';

import { getPaths, initMonadHome } from '@monad/home';

import { startDaemon, stopDaemon } from '../lib/daemon.ts';
import { t } from '../lib/i18n.ts';
import { ask, checkInitialized, runTerminalInit } from '../lib/init-flow.ts';
import { bold, dim, out, yellow } from '../lib/output.ts';

export const command: CommandDef = {
  name: 'init',
  synopsis: 'init [--no-input]',
  description: 'initialize monad (interactive setup: home directory + model provider)',
  descriptionKey: 'cli.cmd.init.desc',
  flags: {
    'non-interactive': { type: 'boolean', description: 'seed home without prompting (alias of --no-input)' }
  },
  async run({ flags, globals, client }) {
    const nonInteractive = globals.yes || flags.nonInteractive === true;

    if (nonInteractive) {
      await initMonadHome(getPaths());
      return;
    }

    if (await checkInitialized(client)) {
      out(yellow(t('cli.init.already')));
      out(dim(t('cli.init.startOver')));
      return;
    }

    const success = await runTerminalInit(client);
    if (!success) return;

    out('');
    const answer = await ask(`${bold(t('cli.startDaemonPrompt'))} [Y/n] `);
    if (answer === '' || /^y$/i.test(answer)) {
      try {
        await client.treaty.health.get();
        out(dim(t('cli.init.restarting')));
        await stopDaemon();
        await startDaemon();
      } catch {
        await initMonadHome(getPaths());
        await startDaemon();
      }
    }
  }
};
