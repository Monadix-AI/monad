import type { CommandDef } from './types.ts';

import { startDaemon, stopDaemon } from '../lib/daemon.ts';

export const command: CommandDef = {
  local: true,
  name: 'restart',
  synopsis: 'restart',
  description: 'restart the daemon',
  descriptionKey: 'cli.cmd.restart.desc',
  async run() {
    await stopDaemon();
    await startDaemon();
  }
};
