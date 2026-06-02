import type { CommandDef } from '../types.ts';

import { addCredentialBodySchema } from '@monad/protocol';

import { t } from '../../lib/i18n.ts';
import { bold, cyan, dim, green, json, out, red } from '../../lib/output.ts';
import { requireTreatyData } from '../../lib/treaty.ts';
import { usageError } from '../types.ts';

// Secrets never leave the daemon: list shows only `accessTokenPreview`, and add
// echoes just the new credential id — never the raw token the user passed in.
export const command: CommandDef = {
  name: 'credentials',
  aliases: ['creds'],
  synopsis: 'credentials <list|add|delete|test> <providerId> [arg]',
  description: 'manage provider credentials',
  descriptionKey: 'cli.model.credentials.desc',
  async run({ positionals: args, client }) {
    const [action, providerId, arg, arg2] = args;
    if (!action || action === 'list') {
      if (!providerId) throw usageError('usage: monad credential list <providerId>');
      const { credentials } = requireTreatyData(
        await client.treaty.v1.settings.model.providers({ id: providerId }).credentials.get()
      );
      json(credentials);
      if (credentials.length === 0) {
        out(dim(t('cli.empty.credentials')));
        return;
      }
      for (const c of credentials) {
        const status =
          c.lastStatus === 'ok'
            ? green(c.lastStatus)
            : c.lastStatus === 'error'
              ? red(c.lastStatus)
              : dim(c.lastStatus);
        out(cyan(c.id) + dim('  ') + bold(c.label) + dim(`  ${c.authType}  ${c.accessTokenPreview ?? '—'}  `) + status);
      }
      return;
    }

    switch (action) {
      case 'add': {
        if (!providerId || !arg) throw usageError('usage: monad credential add <providerId> <json>');
        const body = addCredentialBodySchema.parse(JSON.parse(arg));
        const { id } = requireTreatyData(
          await client.treaty.v1.settings.model.providers({ id: providerId }).credentials.post(body)
        );
        out(green(t('cli.added')) + dim(`  ${id}`));
        return;
      }
      case 'delete':
      case 'remove':
      case 'rm': {
        if (!providerId || !arg) throw usageError('usage: monad credential remove <providerId> <credId>');
        requireTreatyData(
          await client.treaty.v1.settings.model.providers({ id: providerId }).credentials({ credId: arg }).delete()
        );
        out(green(t('cli.deleted')) + dim(`  ${arg}`));
        return;
      }
      case 'test': {
        if (!providerId || !arg) throw usageError('usage: monad credential test <providerId> <credId> [modelId]');
        const result = requireTreatyData(
          await client.treaty.v1.settings.model
            .providers({ id: providerId })
            .credentials({ credId: arg })
            .test.post(arg2 ? { modelId: arg2 } : undefined)
        );
        if (result.ok) out(green(t('cli.ok')) + dim(result.latencyMs != null ? `  ${result.latencyMs}ms` : ''));
        else out(red(t('cli.failed')) + dim(`  ${result.error ?? 'unknown error'}`));
        return;
      }
      default:
        throw new Error(t('cli.model.credentials.unknownAction', { action: String(action) }));
    }
  }
};
