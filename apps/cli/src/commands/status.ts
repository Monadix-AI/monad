import type { CommandDef } from './types.ts';

import { t } from '../lib/i18n.ts';
import { bold, dim, green, json, out, yellow } from '../lib/output.ts';
import { CliError, EXIT } from './types.ts';

export const command: CommandDef = {
  name: 'status',
  synopsis: 'status',
  description: 'check whether the daemon is running',
  descriptionKey: 'cli.cmd.status.desc',
  async run({ client, globals }) {
    const { data: health } = await client.treaty.health.get();

    // A null body means the daemon is unreachable (no connection / 5xx). Report that plainly
    // and exit non-zero (EXIT.DAEMON) so scripts can detect a down daemon.
    if (health === null) {
      json({ status: 'down' });
      out(yellow(t('cli.daemon.notRunning')));
      throw new CliError('', EXIT.DAEMON);
    }

    const h = health as {
      status?: string;
      version?: string;
      latestVersion?: string;
      latestVersionCheckedAt?: string;
    };
    const status = h.status ?? 'unknown';
    json({ status, ...(health as Record<string, unknown>) });
    const color = status === 'ok' ? green : yellow;
    out(color(`● ${status}`) + dim(`  v${h.version ?? '?'}`));

    if (h.latestVersion && h.latestVersion !== h.version) {
      out(
        yellow(`⬆  ${t('cli.upgrade.available', { current: bold(h.version ?? '?'), latest: bold(h.latestVersion) })}`)
      );
      if (!globals.quiet) out(dim('   run: monad upgrade'));
    } else if (h.latestVersion) {
      out(dim(`   ${t('cli.upgrade.upToDate', { version: h.version ?? '' })}`));
    }

    if (!globals.quiet && h.latestVersionCheckedAt) {
      out(dim(`   (${t('cli.upgrade.checkedAt', { at: new Date(h.latestVersionCheckedAt).toLocaleString() })})`));
    }
  }
};
