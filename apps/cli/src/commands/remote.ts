import type { LocalCommandDef } from './types.ts';

import { t } from '../lib/i18n.ts';
import { bold, dim, out } from '../lib/output.ts';
import { command as tls } from './tls.ts';
import { usageError } from './types.ts';

export const command: LocalCommandDef = {
  local: true,
  name: 'remote',
  group: 'configure',
  synopsis: 'remote tls <show|renew|trust>',
  subcommands: ['tls'],
  description: 'manage the daemon TLS certificate',
  descriptionKey: 'cli.cmd.remote.desc',
  subHelp(args) {
    if (args[0] === 'tls') return [bold('monad remote tls <show|renew|trust>'), '', t('cli.cmd.tls.desc')].join('\n');
    return undefined;
  },
  async run(ctx) {
    const [sub, ...rest] = ctx.positionals;
    if (sub === 'tls') return tls.run({ ...ctx, positionals: rest });
    if (sub === undefined) {
      out(t('cli.subcommands'));
      out(dim(`  ${bold('monad remote tls ')}  ${t('cli.cmd.tls.desc')}`));
      return;
    }
    throw usageError(t('cli.remote.unknownAction', { action: sub }));
  }
};
