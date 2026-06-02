import type { CommandDef } from './types.ts';

import { t } from '../lib/i18n.ts';
import { bold, cyan, dim, json, out } from '../lib/output.ts';
import { requireTreatyData } from '../lib/treaty.ts';

export const command: CommandDef = {
  name: 'licenses',
  synopsis: 'licenses',
  description: 'list third-party package licenses',
  descriptionKey: 'cli.cmd.licenses.desc',
  async run({ client }) {
    const result = requireTreatyData(await client.treaty.v1.licenses.get());
    json(result);

    const { packages } = result;
    if (packages.length === 0) {
      out(dim(t('cli.licenses.empty')));
      return;
    }

    out(bold(t('cli.licenses.title', { count: packages.length })));
    out('');

    const nameWidth = Math.min(Math.max(...packages.map((p) => p.name.length)), 40);
    const verWidth = Math.min(Math.max(...packages.map((p) => p.version.length)), 15);

    for (const pkg of packages) {
      const name = cyan(pkg.name.padEnd(nameWidth));
      const ver = dim(pkg.version.padEnd(verWidth));
      const lic = bold(pkg.license);
      const home = pkg.homepage ? dim(`  ${pkg.homepage}`) : '';
      out(`  ${name}  ${ver}  ${lic}${home}`);
    }
  }
};
