import type { CommandDef } from './types.ts';

import { stopDaemon } from '../lib/daemon.ts';

export const command: CommandDef = {
  local: true,
  name: 'stop',
  aliases: ['down'],
  synopsis: 'stop',
  description: 'stop the running daemon',
  descriptionKey: 'cli.cmd.stop.desc',
  async run() {
    await stopDaemon();
  }
};
