import type { CommandDef } from '../types.ts';

import { t } from '../../lib/i18n.ts';
import { cyan, dim, green, json, out } from '../../lib/output.ts';
import { requireTreatyData } from '../../lib/treaty.ts';

export const command: CommandDef = {
  name: 'use',
  synopsis: 'use [alias]',
  description: 'get or set the default model profile',
  descriptionKey: 'cli.model.use.desc',
  async run({ positionals: args, client }) {
    const alias = args[0];
    if (!alias) {
      const result = requireTreatyData(await client.treaty.v1.settings.model.default.get());
      json(result);
      out(result.alias ? cyan(result.alias) : dim(t('cli.noDefault')));
      return;
    }
    requireTreatyData(await client.treaty.v1.settings.model.default.put({ alias }));
    out(green(t('cli.defaultSet')) + dim(`  ${alias}`));
  }
};
