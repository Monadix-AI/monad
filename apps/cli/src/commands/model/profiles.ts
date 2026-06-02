import type { CommandDef } from '../types.ts';

import { profileViewSchema } from '@monad/protocol';

import { t } from '../../lib/i18n.ts';
import { bold, cyan, dim, green, json, out } from '../../lib/output.ts';
import { requireTreatyData } from '../../lib/treaty.ts';
import { usageError } from '../types.ts';

export const command: CommandDef = {
  name: 'profiles',
  synopsis: 'profiles <list|set|delete> [arg]',
  description: 'manage model profiles',
  descriptionKey: 'cli.model.profiles.desc',
  async run({ positionals: args, client }) {
    const [action, arg] = args;
    const profiles = client.treaty.v1.settings.model.profiles;
    switch (action) {
      case 'list':
      case undefined: {
        const result = requireTreatyData(await profiles.get());
        json(result);
        if (result.profiles.length === 0) {
          out(dim(t('cli.empty.profiles')));
          return;
        }
        for (const p of result.profiles) {
          const star = p.alias === result.defaultAlias ? green(' *') : '';
          out(cyan(p.alias) + star + dim('  ') + bold(`${p.routes.chat.provider}/${p.routes.chat.modelId}`));
        }
        return;
      }
      case 'set': {
        if (!arg) throw usageError('usage: monad model set <json>');
        const profile = profileViewSchema.parse(JSON.parse(arg));
        requireTreatyData(await profiles({ alias: profile.alias }).put({ profile }));
        out(green(t('cli.saved')) + dim(`  ${profile.alias}`));
        return;
      }
      case 'delete':
      case 'rm': {
        if (!arg) throw usageError('usage: monad model rm <alias>');
        requireTreatyData(await profiles({ alias: arg }).delete());
        out(green(t('cli.deleted')) + dim(`  ${arg}`));
        return;
      }
      default:
        throw new Error(t('cli.model.profiles.unknownAction', { action: String(action) }));
    }
  }
};
