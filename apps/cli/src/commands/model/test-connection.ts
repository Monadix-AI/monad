import type { CommandDef } from '../types.ts';

import { testConnectionRequestSchema } from '@monad/protocol';

import { t } from '../../lib/i18n.ts';
import { cyan, dim, green, out, red } from '../../lib/output.ts';
import { requireTreatyData } from '../../lib/treaty.ts';
import { usageError } from '../types.ts';

// Stateless "test before add": validate a provider + raw key without persisting.
// On success the daemon returns the provider's model catalogue.
export const command: CommandDef = {
  name: 'test-connection',
  aliases: ['test'],
  synopsis: 'test-connection <json>',
  description: 'probe a provider + key without saving it',
  descriptionKey: 'cli.model.testConnection.desc',
  async run({ positionals: args, client }) {
    const payload = args[0];
    if (!payload) throw usageError('usage: monad model test <json>');
    const body = testConnectionRequestSchema.parse(JSON.parse(payload));
    const result = requireTreatyData(await client.treaty.v1.settings.model['test-connection'].post(body));
    if (!result.ok) {
      out(red(t('cli.failed')) + dim(`  ${result.error ?? 'unknown error'}`));
      return;
    }
    out(green(t('cli.ok')) + dim(result.latencyMs != null ? `  ${result.latencyMs}ms` : ''));
    for (const m of result.models ?? []) out(cyan(m.id) + (m.label ? dim(`  ${m.label}`) : ''));
  }
};
