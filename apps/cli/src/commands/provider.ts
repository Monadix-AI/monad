import type { CommandDef } from './types.ts';

import { command as models } from './model/models.ts';
import { command as providers } from './model/providers.ts';

// Top-level provider noun: list/set/remove providers, plus `models <id>` to list a
// provider's catalogue. Delegates to the shared provider/models handlers.
export const command: CommandDef = {
  name: 'provider',
  group: 'configure',
  aliases: ['prov'],
  synopsis: 'provider <list|set|rm|models> [arg]',
  subcommands: ['list', 'set', 'rm', 'models'],
  description: 'manage model providers (list, set, rm) and list their models',
  descriptionKey: 'cli.cmd.provider.desc',
  async run(ctx) {
    const [action, ...rest] = ctx.positionals;
    if (action === 'models') return models.run({ ...ctx, positionals: rest });
    return providers.run(ctx);
  }
};
