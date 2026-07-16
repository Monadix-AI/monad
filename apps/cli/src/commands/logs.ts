import type { CommandDef } from './types.ts';

import { join } from 'node:path';
import { getPaths } from '@monad/environment';

import { t } from '../lib/i18n.ts';
import { dim, out } from '../lib/output.ts';

function logPath(): string {
  return join(getPaths().logs, 'daemon.log');
}

// Tail the daemon log (the daemon routes its logs to ~/.monad/logs/daemon.log). `-n` controls how
// many trailing lines to show; `-f` follows the file for new output until interrupted.
export const command: CommandDef = {
  local: true,
  name: 'logs',
  synopsis: 'logs [-f] [-n <lines>]',
  description: "show the daemon's logs (-f to follow, -n to set the number of lines)",
  descriptionKey: 'cli.cmd.logs.desc',
  flags: {
    follow: { type: 'boolean', alias: 'f', description: 'follow the log for new output' },
    lines: { type: 'number', alias: 'n', description: 'number of trailing lines to show (default 200)' }
  },
  async run({ flags }) {
    const follow = flags.follow === true || flags.f === true;
    const nRaw = flags.lines ?? flags.n;
    const n = typeof nRaw === 'number' ? nRaw : nRaw ? Number(nRaw) : 200;

    const file = Bun.file(logPath());
    if (!(await file.exists())) {
      out(dim(t('cli.logs.empty')));
      return;
    }

    const text = await file.text();
    const lines = text.split('\n');
    const tail = lines.slice(Math.max(0, lines.length - n - 1));
    process.stdout.write(tail.join('\n'));

    if (!follow) {
      if (!text.endsWith('\n')) process.stdout.write('\n');
      return;
    }

    // Follow: poll the file size and stream appended bytes until interrupted (Ctrl-C).
    let offset = file.size;
    process.on('SIGINT', () => process.exit(0));
    for (;;) {
      await Bun.sleep(400);
      const f = Bun.file(logPath());
      const size = f.size;
      if (size > offset) {
        process.stdout.write(await f.slice(offset, size).text());
        offset = size;
      } else if (size < offset) {
        offset = 0; // file was rotated/truncated — start over
      }
    }
  }
};
