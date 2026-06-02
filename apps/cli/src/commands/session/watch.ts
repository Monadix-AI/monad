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
    // watchSession holds the WS control stream for lifecycle and opens an SSE generation
    // subscription only while a turn is in flight — see docs/realtime-channels.md.
    const dispose = client.watchSession(sessionId as SessionId, (event) => {
      if (isStructured()) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      } else {
        const type = (event as { type?: string }).type;
        const prefix = type ? `${cyan(type)} ` : '';
        out(prefix + dim(JSON.stringify(event)));
      }
    });
    await new Promise<void>((resolve) => process.once('SIGINT', resolve));
    dispose();
  }
};
