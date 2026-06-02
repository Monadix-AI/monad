import type { CommandDef } from './types.ts';

import { resolveClientConn } from '@monad/environment';

import { startDaemon } from '../lib/daemon.ts';
import { t } from '../lib/i18n.ts';
import { dim, json, out } from '../lib/output.ts';

export const command: CommandDef = {
  local: true,
  name: 'start',
  group: 'daemon',
  synopsis: 'start',
  description: 'start the daemon',
  descriptionKey: 'cli.cmd.start.desc',
  async run() {
    const { alreadyRunning } = await startDaemon();
    const { baseUrl } = await resolveClientConn();
    json({ daemon: alreadyRunning ? 'already-running' : 'started', baseUrl });
    if (alreadyRunning) out(dim(t('cli.start.webUi', { url: baseUrl })));
  }
};
