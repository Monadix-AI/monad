import type { CommandDef } from './types.ts';

import { t } from '../lib/i18n.ts';
import { command as defaultProfile } from './model/default.ts';
import { command as profiles } from './model/profiles.ts';
import { command as testConnection } from './model/test-connection.ts';
import { CliError, EXIT } from './types.ts';

// Model profiles live directly under `model` (list/set/rm); `use` gets/sets the default
// profile; `test` probes a provider+key without saving. Providers and credentials are their
// own top-level nouns (`monad provider`, `monad credential`).
export const command: CommandDef = {
  name: 'model',
  aliases: ['m'],
  synopsis: 'model <list|set|rm|use|test> [arg]',
  description: 'manage model profiles (list, set, rm), the default (use), and connection tests (test)',
  descriptionKey: 'cli.cmd.model.desc',
  async run(ctx) {
    const [action, ...rest] = ctx.positionals;
    switch (action) {
      case undefined:
      case 'list':
      case 'set':
      case 'rm':
      case 'delete':
        return profiles.run(ctx);
      case 'use':
      case 'default':
        return defaultProfile.run({ ...ctx, positionals: rest });
      case 'test':
        return testConnection.run({ ...ctx, positionals: rest });
      default:
        throw new CliError(t('cli.model.unknownAction', { action: String(action) }), EXIT.USAGE);
    }
  }
};
