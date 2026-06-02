import type { SessionId } from '@monad/protocol';
import type { SessionCommandDef } from './types.ts';

import { dim, green, json, out, yellow } from '../../lib/output.ts';
import { requireTreatyData } from '../../lib/treaty.ts';
import { usageError } from '../types.ts';

export const command: SessionCommandDef = {
  name: 'abort',
  synopsis: 'abort <sessionId>',
  description: 'cancel an in-flight run for a session',
  descriptionKey: 'cli.session.abort.desc',
  async run({ positionals: args, client }) {
    const id = args[0];
    if (!id) throw usageError('usage: monad session abort <sessionId>');
    const { aborted } = requireTreatyData(await client.treaty.v1.sessions({ id: id as SessionId }).abort.post());
    json({ aborted, sessionId: id });
    out(aborted ? green('aborted') + dim(`  ${id}`) : yellow('nothing to abort'));
  }
};
