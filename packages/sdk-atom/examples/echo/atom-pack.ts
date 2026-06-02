// Example atom pack — a loopback "echo" channel. Demonstrates the full authoring shape:
// defineChannel (the channel capability) + defineAtomPack (the unified envelope) with a
// manifest that DECLARES only the `channel` atom. A real channel talks to a platform over
// the network; this one loops back so you can exercise the agent end-to-end with no credentials.
//
// To ship a real atom pack: bundle this to a single file
//   bun build ./atom-pack.ts --target=bun --outfile dist/atom-pack.js
// and drop `<name>/{atom-pack.json, dist/atom-pack.js}` into ~/.monad/atoms/.

import { defineAtomPack, defineChannel } from '@monad/sdk-atom';

const CAPS = {
  edit: false,
  typing: false,
  threads: false,
  maxMessageChars: 4096,
  markdown: false,
  reactions: false,
  nativeCommands: false,
  outboundMirror: false
};

export const echoChannelAtom = defineChannel({
  type: 'echo',
  name: 'Echo (loopback test channel)',
  capabilities: CAPS,
  create(ctx) {
    let seq = 0;
    return {
      type: 'echo',
      capabilities: CAPS,
      async connect() {},
      async disconnect() {},
      async send(chatId, content) {
        // Loopback: turn an outbound back into a fresh inbound so the agent can be driven with no
        // real platform. The "↩" guard prevents an infinite agent⇄channel loop. A REAL adapter
        // would instead deliver `content` to the platform and never call onMessage from send().
        if (!content.startsWith('↩')) {
          ctx.onMessage({
            chatId,
            userId: 'echo-user',
            text: `↩ ${content}`,
            kind: 'text',
            commandArgs: [],
            nativeMessageId: `echo-${++seq}`,
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

export default defineAtomPack({
  manifest: {
    name: 'echo',
    version: '1.0.0',
    sdkVersion: '0',
    atoms: ['channel'],
    description: 'Loopback test channel — demonstrates the channel atom kind'
  },
  channels: [echoChannelAtom]
});
