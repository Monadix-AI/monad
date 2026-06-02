import type { CommandDef } from '../types.ts';

import { t } from '../../lib/i18n.ts';
import { cyan, dim, json, out } from '../../lib/output.ts';
import { requireTreatyData } from '../../lib/treaty.ts';
import { usageError } from '../types.ts';

export const command: CommandDef = {
  name: 'models',
  synopsis: 'models <providerId>',
  description: "list a provider's available models",
  descriptionKey: 'cli.model.models.desc',
  async run({ positionals: args, client }) {
    const providerId = args[0];
    if (!providerId) throw usageError('usage: monad model models <providerId>');
    const { models } = requireTreatyData(
      await client.treaty.v1.settings.model.providers({ id: providerId }).models.get()
    );
    json(models);
    if (models.length === 0) {
      out(dim(t('cli.empty.models')));
      return;
    }
    for (const m of models) out(cyan(m.id) + (m.label ? dim(`  ${m.label}`) : ''));
  }
};
