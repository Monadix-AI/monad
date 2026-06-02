import type { CommandDef } from '../types.ts';

import { providerViewSchema } from '@monad/protocol';

import { t } from '../../lib/i18n.ts';
import { bold, cyan, dim, green, json, out } from '../../lib/output.ts';
import { requireTreatyData } from '../../lib/treaty.ts';
import { usageError } from '../types.ts';

export const command: CommandDef = {
  name: 'providers',
  synopsis: 'providers <list|set|delete> [arg]',
  description: 'manage model providers',
  descriptionKey: 'cli.model.providers.desc',
  async run({ positionals: args, client }) {
    const [action, arg] = args;
    const providers = client.treaty.v1.settings.model.providers;
    switch (action) {
      case 'list':
      case undefined: {
        const result = requireTreatyData(await providers.get());
        json(result.providers);
        if (result.providers.length === 0) {
          out(dim(t('cli.empty.providers')));
          return;
        }
        for (const p of result.providers) {
          out(cyan(p.id) + dim('  ') + bold(p.label) + dim(`  ${p.type}${p.baseUrl ? `  ${p.baseUrl}` : ''}`));
        }
        return;
      }
      case 'set':
      case 'add': {
        if (!arg) throw usageError('usage: monad provider set <json>');
        const provider = providerViewSchema.parse(JSON.parse(arg));
        requireTreatyData(await providers({ id: provider.id }).put({ provider }));
        out(green(t('cli.saved')) + dim(`  ${provider.id}`));
        return;
      }
      case 'delete':
      case 'remove':
      case 'rm': {
        if (!arg) throw usageError('usage: monad provider remove <id>');
        requireTreatyData(await providers({ id: arg }).delete());
        out(green(t('cli.deleted')) + dim(`  ${arg}`));
        return;
      }
      default:
        throw new Error(t('cli.model.providers.unknownAction', { action: String(action) }));
    }
  }
};
