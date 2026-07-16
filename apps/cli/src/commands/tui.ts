import type { CommandDef } from './types.ts';

import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { resolveClientConn } from '@monad/environment';

import { startDaemon } from '../lib/daemon.ts';
import { t } from '../lib/i18n.ts';
import { dim, out, yellow } from '../lib/output.ts';

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    })
  );
}

export function formatDaemonUnreachableHint(baseUrl: string): string {
  return yellow(t('cli.console.unreachable')) + dim(`  (${baseUrl})`);
}

export const command: CommandDef = {
  name: 'tui',
  synopsis: 'tui',
  description: 'open the interactive TUI',
  descriptionKey: 'cli.cmd.tui.desc',
  async run({ client }) {
    try {
      await client.treaty.health.get();
    } catch {
      const { baseUrl } = await resolveClientConn();
      out(formatDaemonUnreachableHint(baseUrl));
      const answer = await prompt(`${t('cli.startDaemonPrompt')} [Y/n] `);
      if (answer === '' || /^y$/i.test(answer)) {
        await startDaemon();
        // Wait up to 5 s for the daemon to become reachable
        let ready = false;
        for (let i = 0; i < 20; i++) {
          await Bun.sleep(250);
          try {
            await client.treaty.health.get();
            ready = true;
            break;
          } catch {
            /* not yet */
          }
        }
        if (!ready) {
          out(yellow(t('cli.console.notReady')));
          return;
        }
      } else {
        return;
      }
    }

    // Dev: spawn the TUI source directly. Release: the compiled binary has no source tree, so use
    // the bundled entry. Mirrors daemon.ts / acp.ts so `monad tui` behaves the same everywhere.
    const devEntry = resolve(import.meta.dir, '../../../tui/src/main.tsx');
    if (await Bun.file(devEntry).exists()) {
      const proc = Bun.spawn(['bun', devEntry], {
        env: { ...Bun.env },
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit'
      });
      process.exitCode = await proc.exited;
    } else {
      await (await import('@monad/tui/start')).startTui();
    }
  }
};
