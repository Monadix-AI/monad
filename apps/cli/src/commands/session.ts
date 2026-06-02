import type { CommandDef } from './types.ts';

import { renderSessionSubHelp, runSessionCommand } from './session/index.ts';

export const command: CommandDef = {
  name: 'session',
  group: 'work',
  aliases: ['s'],
  synopsis: 'session <subcommand>',
  subcommands: [
    'new',
    'list',
    'show',
    'messages',
    'send',
    'watch',
    'search',
    'plan',
    'branch',
    'restore',
    'reset',
    'abort',
    'rm'
  ],
  description: 'session operations (create, list, chat, search, branch, restore, …)',
  descriptionKey: 'cli.cmd.session.desc',
  subHelp: (args) => renderSessionSubHelp(args),
  async run(ctx) {
    await runSessionCommand(ctx);
  }
};
