import type { CommandDef } from './types.ts';

import { command as credentials } from './model/credentials.ts';

// Top-level credential noun: manage a provider's stored credentials. Secrets never leave the
// daemon — list shows only a token preview, add echoes just the new id. Delegates to the handler.
export const command: CommandDef = {
  name: 'credential',
  group: 'configure',
  aliases: ['cred', 'creds'],
  synopsis: 'credential <list|add|rm|test> <providerId> [json|-]',
  subcommands: ['list', 'add', 'rm', 'test'],
  description: 'manage provider credentials (list, add, rm, test)',
  descriptionKey: 'cli.cmd.credential.desc',
  async run(ctx) {
    return credentials.run(ctx);
  }
};
