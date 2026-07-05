// Signal channel adapter — drives signal-cli in JSON-RPC mode over a child process. Signal has no
// official bot API; signal-cli (operator-installed, separately registered) is the sanctioned bridge.
// We spawn `signal-cli -a <account> jsonRpc`, read newline-delimited JSON notifications, and write
// `send` requests to stdin. Pure platform I/O; never touches sessions.
//
// options: { account, cliPath?='signal-cli' }  — `account` is the registered number ("+1…").

import type { ChannelInbound } from '@monad/protocol';
import type { ChannelAdapter, ChannelCapabilities, ChannelContext, SentMessage } from '@monad/sdk-atom';

import { defineChannel } from '@monad/sdk-atom';
import { z } from 'zod';

const SIGNAL_CAPABILITIES: ChannelCapabilities = {
  edit: false,
  typing: false,
  threads: false,
  maxMessageChars: 2000,
  markdown: false,
  reactions: false,
  nativeCommands: false,
  outboundMirror: true
};

const signalEnvelopeSchema = z.looseObject({
  source: z.string().optional(),
  sourceNumber: z.string().optional(),
  sourceUuid: z.string().optional(),
  sourceName: z.string().optional(),
  timestamp: z.number().optional(),
  dataMessage: z
    .looseObject({
      message: z.string().nullable().optional(),
      groupInfo: z.looseObject({ groupId: z.string().optional() }).optional(),
      mentions: z.array(z.looseObject({ uuid: z.string().optional(), number: z.string().optional() })).optional()
    })
    .optional(),
  syncMessage: z.unknown().optional()
});
type SignalEnvelope = z.infer<typeof signalEnvelopeSchema>;

const signalRpcSchema = z.looseObject({
  method: z.string().optional(),
  params: z.looseObject({ envelope: signalEnvelopeSchema.optional() }).optional()
});

/** Normalize a signal-cli `receive` envelope → ChannelInbound, or null. A group message is keyed by
 *  its groupId; a 1:1 by the sender. `selfId` (account number/uuid) drives the mention gate. Exported
 *  for tests. Sync messages (the account's own outbound mirrored back) are dropped. */
export function normalizeSignalEnvelope(env: SignalEnvelope, selfId?: string): ChannelInbound | null {
  if (env.syncMessage !== undefined) return null; // own message echo
  const dm = env.dataMessage;
  if (!dm || dm.message == null) return null;
  const groupId = dm.groupInfo?.groupId;
  const sender = env.sourceUuid ?? env.sourceNumber ?? env.source ?? '';
  const text = dm.message;
  const isCommand = text.startsWith('/');
  const [head, ...args] = isCommand ? text.trim().split(/\s+/) : [];
  const mentionedSelf =
    selfId !== undefined && (dm.mentions ?? []).some((m) => m.uuid === selfId || m.number === selfId);
  return {
    chatId: groupId ?? sender,
    userId: sender,
    text,
    kind: isCommand ? 'command' : 'text',
    command: head ? head.slice(1).toLowerCase() : undefined,
    commandArgs: args,
    nativeMessageId: String(env.timestamp ?? Date.now()),
    senderDisplay: env.sourceName,
    chatType: groupId ? 'group' : 'dm',
    mentionedSelf,
    isSelf: false,
    media: [],
    at: env.timestamp ? new Date(env.timestamp).toISOString() : new Date().toISOString()
  };
}

export function createSignalAdapter(ctx: ChannelContext): ChannelAdapter {
  const account = String(ctx.config.options.account ?? '');
  const cliPath =
    (typeof ctx.config.options.cliPath === 'string' ? ctx.config.options.cliPath : 'signal-cli') || 'signal-cli';
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let rpcId = 0;

  function rpc(method: string, params: unknown): void {
    const writer = proc?.stdin;
    if (writer && typeof writer !== 'number') {
      (writer as { write: (s: string) => void }).write(
        `${JSON.stringify({ jsonrpc: '2.0', id: String(++rpcId), method, params })}\n`
      );
    }
  }

  async function pump(): Promise<void> {
    if (!proc?.stdout || typeof proc.stdout === 'number') return;
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = signalRpcSchema.parse(JSON.parse(line));
          if (msg.method === 'receive' && msg.params?.envelope) {
            const ev = normalizeSignalEnvelope(msg.params.envelope, account);
            if (ev) ctx.onMessage(ev);
          }
        } catch {
          /* signal-cli also prints non-JSON diagnostics; ignore */
        }
      }
    }
  }

  return {
    type: 'signal',
    capabilities: SIGNAL_CAPABILITIES,

    async connect() {
      if (!account) throw new Error('signal: options.account (registered number) is required');
      try {
        proc = Bun.spawn([cliPath, '-a', account, 'jsonRpc'], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
        ctx.trackProcess?.(proc, 'channel:signal');
      } catch {
        throw new Error(
          `signal: could not start signal-cli at "${cliPath}" — install it and register your number first`
        );
      }
      void pump();
      ctx.signal.addEventListener('abort', () => proc?.kill());
    },

    async disconnect() {
      proc?.kill();
      proc = undefined;
    },

    async send(chatId: string, content: string): Promise<SentMessage> {
      // A group id is base64 (contains +/=, never a leading +); a recipient number starts with +.
      const isGroup = !chatId.startsWith('+');
      rpc('send', isGroup ? { groupId: chatId, message: content } : { recipient: [chatId], message: content });
      return { ref: `sig-${Date.now()}`, chatId };
    }
  };
}

export const signalChannelAtom = defineChannel({
  type: 'signal',
  name: 'Signal (signal-cli)',
  capabilities: SIGNAL_CAPABILITIES,
  envVars: [],
  create: createSignalAdapter
});
