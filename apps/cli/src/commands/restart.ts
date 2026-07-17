import type { DaemonLifecycleOptions } from '../lib/daemon.ts';
import type { StatusLine } from '../lib/status-line.ts';
import type { CommandDef } from './types.ts';

import { startDaemon, stopDaemon } from '../lib/daemon.ts';
import { t } from '../lib/i18n.ts';
import { startStatusLine } from '../lib/status-line.ts';

interface RestartMessages {
  failed: string;
  restarted: string;
  restarting: string;
}

interface RestartDeps {
  messages: RestartMessages;
  start: (options: DaemonLifecycleOptions) => Promise<{ alreadyRunning: boolean }>;
  status: (message: string) => StatusLine;
  stop: (options: Pick<DaemonLifecycleOptions, 'silent'>) => Promise<void>;
}

function defaultRestartDeps(): RestartDeps {
  return {
    messages: {
      failed: t('cli.daemon.restartFailed'),
      restarted: t('cli.daemon.restarted'),
      restarting: t('cli.daemon.restarting')
    },
    start: startDaemon,
    status: startStatusLine,
    stop: stopDaemon
  };
}

export async function restartDaemon(deps: RestartDeps = defaultRestartDeps()): Promise<void> {
  const status = deps.status(deps.messages.restarting);
  try {
    await deps.stop({ silent: true });
    await deps.start({ requireReady: true, silent: true });
    status.success(deps.messages.restarted);
  } catch (error) {
    status.fail(deps.messages.failed);
    throw error;
  }
}

export const command: CommandDef = {
  local: true,
  name: 'restart',
  synopsis: 'restart',
  description: 'restart the daemon',
  descriptionKey: 'cli.cmd.restart.desc',
  async run() {
    await restartDaemon();
  }
};
