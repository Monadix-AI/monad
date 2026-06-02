import type { CommandDef } from './types.ts';

import { runSessionCommand } from './session/index.ts';

export const command: CommandDef = {
  name: 'session',
  aliases: ['s'],
  synopsis: 'session <subcommand>',
  description: 'session operations (create, list, chat, search, branch, restore, …)',
  descriptionKey: 'cli.cmd.session.desc',
  async run(ctx) {
    await runSessionCommand(ctx);
  }
};
