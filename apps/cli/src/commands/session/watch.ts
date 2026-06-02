import type { SessionId } from '@monad/protocol';
import type { SessionCommandDef } from './types.ts';

import { t } from '../../lib/i18n.ts';
import { cyan, dim, isStructured, out } from '../../lib/output.ts';
import { CliError, EXIT, usageError } from '../types.ts';

function flagList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return value ? [String(value)] : [];
}

export const command: SessionCommandDef = {
  name: 'watch',
  aliases: ['tail'],
  synopsis: 'watch <sessionId> [--until <eventType>] [--timeout <seconds>]',
  description: "stream a session's events (Ctrl-C to stop; --json emits NDJSON)",
  descriptionKey: 'cli.session.watch.desc',
  flags: {
    until: {
      type: 'string',
      description: 'stop after this event type arrives; repeat to stop on any of several',
      descriptionKey: 'cli.session.watch.until'
    },
    timeout: {
      type: 'number',
      description: 'stop after this many seconds and exit non-zero',
      descriptionKey: 'cli.session.watch.timeout'
    }
  },
  async run({ positionals: args, flags, client }) {
    const sessionId = args[0];
    if (!sessionId) throw usageError('usage: monad session watch <sessionId> [--until <eventType>]');
    const until = new Set(flagList(flags.until));
    const timeoutSeconds = typeof flags.timeout === 'number' ? flags.timeout : undefined;
    if (timeoutSeconds !== undefined && timeoutSeconds <= 0) throw usageError(t('cli.session.watch.badTimeout'));

    if (!isStructured()) out(dim(t('cli.session.watch.watching', { id: sessionId })));

    // Without a stop condition this runs until Ctrl-C, which is right at a terminal and useless in a
    // script: `send --detach && watch` would hang forever. `--until` ends the stream on a named
    // event; `--timeout` bounds the wait and exits non-zero so a pipeline can tell "it never came"
    // apart from "it arrived".
    const timedOut = await new Promise<boolean>((resolve) => {
      let settled = false;
      let dispose: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (viaTimeout: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        process.off('SIGINT', onSigint);
        dispose?.();
        resolve(viaTimeout);
      };
      function onSigint(): void {
        settle(false);
      }

      process.once('SIGINT', onSigint);
      if (timeoutSeconds !== undefined) timer = setTimeout(() => settle(true), timeoutSeconds * 1000);

      dispose = client.subscribeControl((event) => {
        if (event.sessionId !== (sessionId as SessionId)) return;
        const type = (event as { type?: string }).type;
        if (isStructured()) {
          process.stdout.write(`${JSON.stringify(event)}\n`);
        } else {
          out((type ? `${cyan(type)} ` : '') + dim(JSON.stringify(event)));
        }
        if (type && until.has(type)) settle(false);
      });
      // `settle` may have run synchronously from an event delivered during subscribe.
      if (settled) dispose();
    });

    if (timedOut) throw new CliError(t('cli.session.watch.timedOut', { seconds: timeoutSeconds ?? 0 }), EXIT.ERROR);
  }
};
