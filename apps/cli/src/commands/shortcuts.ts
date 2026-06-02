import type { CommandDef } from './types.ts';

import { resolveClientConn } from '@monad/environment';

import { startAndOpenWeb } from '../lib/open-web.ts';
import { command as agent } from './agent.ts';
import { command as chat } from './chat.ts';
import { command as model } from './model.ts';
import { command as session } from './session.ts';

// Friendly top-level shortcuts that delegate into a group command by prefixing a subcommand.
// Hidden from the usage table (documented in docs/internal/development/cli-design.md) to keep top-level help
// clean. Every entry here must also appear in that document's alias table.
function shortcut(name: string, target: CommandDef, prefix: string[], synopsis: string): CommandDef {
  return {
    name,
    hidden: true,
    synopsis,
    description: `alias for ${prefix.length ? `${target.name} ${prefix.join(' ')}` : target.name}`,
    run: (ctx) => target.run({ ...ctx, positionals: [...prefix, ...ctx.positionals] })
  };
}

export const shortcutCommands: CommandDef[] = [
  shortcut('ls', session, ['list'], 'ls'),
  shortcut('ps', session, ['list'], 'ps'),
  shortcut('new', session, ['new'], 'new <title>'),
  shortcut('rm', session, ['rm'], 'rm <sessionId>'),
  shortcut('models', model, ['list'], 'models'),
  shortcut('agents', agent, ['list'], 'agents'),
  // `up` = the bare `monad` behavior: start the daemon and open the web UI.
  {
    name: 'up',
    hidden: true,
    synopsis: 'up',
    description: 'alias for bare `monad` (start the daemon and open the web UI)',
    async run({ client }) {
      const { baseUrl } = await resolveClientConn();
      await startAndOpenWeb(client, baseUrl);
    }
  },
  // `ask` = a one-shot, non-streaming chat.
  {
    name: 'ask',
    hidden: true,
    synopsis: 'ask <text|->',
    description: 'alias for chat --no-stream',
    run: (ctx) => chat.run({ ...ctx, flags: { ...ctx.flags, stream: false } })
  }
];
