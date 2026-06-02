import type { CommandDef } from './types.ts';

import { resolveClientConn } from '@monad/home';

import { startDaemon } from '../lib/daemon.ts';
import { t } from '../lib/i18n.ts';
import { dim, out } from '../lib/output.ts';

export const command: CommandDef = {
  local: true,
  name: 'start',
  synopsis: 'start',
  description: 'start the daemon',
  descriptionKey: 'cli.cmd.start.desc',
  async run() {
    const { alreadyRunning } = await startDaemon();
    if (alreadyRunning) {
      const { baseUrl } = await resolveClientConn();
      out(dim(t('cli.start.webUi', { url: baseUrl })));
    }
  }
};
