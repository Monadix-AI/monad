// Example atom pack — a SINGLE pack that bundles FOUR atom kinds at once: a channel, a slash
// command, a model provider, and a custom message type. This is the reference for the "one
// submission, many atoms" shape: the manifest DECLARES every kind it touches (`atoms: [...]`) and
// the host enforces it — registering a kind you didn't declare throws UndeclaredAtomError.
//
// To ship: bundle to a single file and drop `<name>/{atom-pack.json, dist/atom-pack.js}` into
// ~/.monad/atoms/   →   bun build ./atom-pack.ts --target=bun --outfile dist/atom-pack.js

import { defineAtomPack, defineChannel, defineCommand, defineProvider } from '@monad/sdk-atom';
import { z } from 'zod';

const CAPS = {
  edit: false,
  typing: false,
  threads: false,
  maxMessageChars: 4096,
  markdown: true,
  reactions: false,
  nativeCommands: false,
  outboundMirror: false
};

/** channel atom — a loopback channel (same idea as the echo example). */
const demoChannelAtom = defineChannel({
  type: 'multi-demo',
  name: 'Multi Demo (loopback)',
  capabilities: CAPS,
  create(ctx) {
    let seq = 0;
    return {
      type: 'multi-demo',
      capabilities: CAPS,
      async connect() {},
      async disconnect() {},
      async send(chatId, content) {
        if (!content.startsWith('↩')) {
          ctx.onMessage({
            chatId,
            userId: 'demo-user',
            text: `↩ ${content}`,
            kind: 'text',
            commandArgs: [],
            nativeMessageId: `demo-${++seq}`,
            isSelf: false,
            media: [],
            at: '1970-01-01T00:00:00.000Z'
          });
        }
        return { ref: String(++seq), chatId };
      }
    };
  }
});

/** command atom — a non-reserved slash command attributed to this pack. */
const pingCommandAtom = defineCommand({
  name: 'multi-ping',
  description: 'Reply with pong (demonstrates the command atom kind)',
  async run(_ctx, args) {
    return { message: args.trim() ? `pong: ${args.trim()}` : 'pong' };
  }
});

/** provider atom — a trivial native provider that streams a canned reply. */
const demoProviderAtom = defineProvider({
  type: 'multi-demo',
  descriptor: { type: 'multi-demo', label: 'Multi Demo Provider', strategy: 'native' },
  async *stream() {
    yield { type: 'text', token: 'hello from multi-demo' } as const;
    yield { type: 'finish', reason: 'stop' } as const;
  }
});

/** message-type atom — a custom rich type. The host namespaces it as `<packId>:badge`. */
const badgeMessageType = {
  type: 'badge',
  dataSchema: z.object({ label: z.string(), tone: z.enum(['info', 'warn']).optional() }),
  fallbacks: ['markdown', 'text'] as const,
  includeInContext: true
};

export default defineAtomPack({
  manifest: {
    name: 'multi-demo',
    version: '1.0.0',
    sdkVersion: '0',
    atoms: ['channel', 'command', 'provider', 'message-type'],
    description: 'Reference multi-atom pack: channel + command + provider + message-type'
  },
  channels: [demoChannelAtom],
  commands: [pingCommandAtom],
  providers: [demoProviderAtom],
  messageTypes: [badgeMessageType]
});
