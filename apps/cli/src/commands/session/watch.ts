import type { SessionId } from '@monad/protocol';
import type { SessionCommandDef } from './types.ts';

import { cyan, dim, isStructured, out } from '../../lib/output.ts';
import { usageError } from '../types.ts';

export const command: SessionCommandDef = {
  name: 'watch',
  aliases: ['tail'],
  synopsis: 'watch <sessionId>',
  description: "stream a session's events (Ctrl-C to stop; --json emits NDJSON)",
  descriptionKey: 'cli.session.watch.desc',
  async run({ positionals: args, client }) {
    const sessionId = args[0];
    if (!sessionId) throw usageError('usage: monad session watch <sessionId>');
    if (!isStructured()) out(dim(`watching ${sessionId}  (Ctrl-C to stop)`));
    const dispose = client.subscribeControl((event) => {
      if (event.sessionId !== (sessionId as SessionId)) return;
      if (isStructured()) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      } else {
        const type = (event as { type?: string }).type;
        const prefix = type ? `${cyan(type)} ` : '';
        out(prefix + dim(JSON.stringify(event)));
      }
    });
    try {
      await new Promise<void>((resolve) => process.once('SIGINT', resolve));
    } finally {
      dispose();
    }
  }
};
