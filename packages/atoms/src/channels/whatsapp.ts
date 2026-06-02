import type { ChannelInbound } from '@monad/protocol';
import type { ChannelAdapter, ChannelCapabilities, ChannelContext, SentMessage } from '@monad/sdk-atom';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';

import { mkdir } from 'node:fs/promises';
import { defineChannel } from '@monad/sdk-atom';
import makeWASocket, {
  areJidsSameUser,
  Browsers,
  DisconnectReason,
  generateMessageIDV2,
  jidNormalizedUser,
  normalizeMessageContent,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';

import { channelIcons } from './icons.ts';
import { channelSetupGuides } from './setup-guides.ts';

const WHATSAPP_CAPABILITIES: ChannelCapabilities = {
  edit: false,
  typing: true,
  threads: false,
  maxMessageChars: 4096,
  markdown: false,
  reactions: false,
  nativeCommands: false,
  outboundMirror: true
};

interface WhatsappWebMessage {
  key: { remoteJid?: string | null; participant?: string | null; fromMe?: boolean | null; id?: string | null };
  pushName?: string | null;
  message?: {
    conversation?: string | null;
    extendedTextMessage?: {
      text?: string | null;
      contextInfo?: { mentionedJid?: Array<string | null> | null } | null;
    } | null;
    imageMessage?: { caption?: string | null } | null;
    videoMessage?: { caption?: string | null } | null;
  } | null;
}

const WELCOME_MARKER = '.connected-welcome-v1';
const MAX_OWN_MESSAGE_IDS = 512;

function rememberOwnMessage(ids: Set<string>, id: string): void {
  ids.add(id);
  if (ids.size <= MAX_OWN_MESSAGE_IDS) return;
  const oldest = ids.values().next().value;
  if (oldest) ids.delete(oldest);
}

export function normalizeWhatsappWebMessage(message: WhatsappWebMessage): ChannelInbound | null {
  const chatId = message.key.remoteJid ?? '';
  const nativeMessageId = message.key.id ?? '';
  if (!chatId || !nativeMessageId || chatId === 'status@broadcast') return null;
  const content = message.message;
  const text =
    content?.conversation ??
    content?.extendedTextMessage?.text ??
    content?.imageMessage?.caption ??
    content?.videoMessage?.caption ??
    '';
  if (!text) return null;
  const isCommand = text.startsWith('/');
  const [head, ...args] = isCommand ? text.trim().split(/\s+/) : [];
  return {
    chatId,
    userId: message.key.participant ?? chatId,
    text,
    kind: isCommand ? 'command' : 'text',
    command: head ? head.slice(1).toLowerCase() : undefined,
    commandArgs: args,
    nativeMessageId,
    senderDisplay: message.pushName ?? undefined,
    chatType: chatId.endsWith('@g.us') ? 'group' : 'dm',
    mentionedSelf: Boolean(content?.extendedTextMessage?.contextInfo?.mentionedJid?.length),
    isSelf: Boolean(message.key.fromMe),
    media: [],
    at: new Date().toISOString()
  };
}

export function normalizeWhatsappSocketMessage(
  message: WhatsappWebMessage,
  selfJids: readonly (string | undefined)[],
  ownMessageIds: Set<string>
): ChannelInbound | null {
  const messageId = message.key.id ?? '';
  if (messageId && ownMessageIds.delete(messageId)) return null;
  if (!message.key.fromMe) return normalizeWhatsappWebMessage(message);
  const chatId = message.key.remoteJid ?? '';
  if (!chatId || !selfJids.some((selfJid) => selfJid && areJidsSameUser(chatId, selfJid))) return null;
  return normalizeWhatsappWebMessage({ ...message, key: { ...message.key, fromMe: false } });
}

export async function sendWhatsappWelcomeOnce(args: {
  stateDir: string;
  chatId: string;
  content: string;
  send: (chatId: string, content: string) => Promise<void>;
}): Promise<boolean> {
  const marker = Bun.file(`${args.stateDir}/${WELCOME_MARKER}`);
  if (await marker.exists()) return false;
  await args.send(args.chatId, args.content);
  await Bun.write(marker, `${new Date().toISOString()}\n`);
  return true;
}

function disconnectCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const output = 'output' in error ? (error.output as { statusCode?: unknown } | undefined) : undefined;
  return typeof output?.statusCode === 'number' ? output.statusCode : undefined;
}

export function createWhatsappAdapter(ctx: ChannelContext): ChannelAdapter {
  const stateDir = ctx.stateDir;
  const logger = pino({ level: 'silent' });
  let socket: WASocket | undefined;
  let stopped = false;
  let open = false;
  let generation = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let welcomePromise: Promise<unknown> | undefined;
  const ownMessageIds = new Set<string>();

  const sendTracked = async (target: string, content: string): Promise<WAMessage | undefined> => {
    if (!socket || !open) throw new Error('whatsapp: linked device is not connected');
    const messageId = generateMessageIDV2(socket.user?.id);
    rememberOwnMessage(ownMessageIds, messageId);
    try {
      return await socket.sendMessage(target, { text: content }, { messageId });
    } catch (error) {
      ownMessageIds.delete(messageId);
      throw error;
    }
  };

  const sendWelcome = (selfJid: string) => {
    const content = ctx.config.connectedWelcome;
    if (!content || !stateDir || welcomePromise) return;
    welcomePromise = sendWhatsappWelcomeOnce({
      stateDir,
      chatId: selfJid,
      content,
      send: async (chatId, text) => {
        await sendTracked(chatId, text);
      }
    })
      .catch((error) =>
        ctx.log('warn', `whatsapp: connected welcome failed: ${error instanceof Error ? error.message : String(error)}`)
      )
      .finally(() => {
        welcomePromise = undefined;
      });
  };

  const publishQr = async (qr: string, currentGeneration: number) => {
    const pairingQr = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
    if (!stopped && generation === currentGeneration && !open) ctx.onStatus?.({ phase: 'pairing', pairingQr });
  };

  const startSocket = async () => {
    if (!stateDir) throw new Error('whatsapp: channel state directory is unavailable');
    const currentGeneration = ++generation;
    const { state, saveCreds } = await useMultiFileAuthState(stateDir);
    ctx.onStatus?.({ phase: 'connecting' });
    const next = makeWASocket({
      auth: state,
      browser: Browsers.macOS('Monad'),
      logger,
      markOnlineOnConnect: false
    });
    socket = next;
    next.ev.on('creds.update', saveCreds);
    next.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const nativeMessage of messages) {
        const normalizedContent = normalizeMessageContent(nativeMessage.message);
        const inbound = normalizeWhatsappSocketMessage(
          {
            key: nativeMessage.key,
            pushName: nativeMessage.pushName,
            message: normalizedContent
          },
          [
            next.user?.id,
            next.user?.lid,
            next.user?.phoneNumber,
            state.creds.me?.id,
            state.creds.me?.lid,
            state.creds.me?.phoneNumber
          ],
          ownMessageIds
        );
        if (inbound) ctx.onMessage(inbound);
      }
    });
    next.ev.on('connection.update', (update) => {
      if (generation !== currentGeneration || stopped) return;
      if (update.qr) void publishQr(update.qr, currentGeneration);
      if (update.connection === 'open') {
        open = true;
        ctx.onStatus?.({ phase: 'connected' });
        const selfJid = jidNormalizedUser(next.user?.phoneNumber ?? next.user?.id);
        if (selfJid) sendWelcome(selfJid);
        return;
      }
      if (update.connection !== 'close') return;
      open = false;
      const code = disconnectCode(update.lastDisconnect?.error);
      if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession) {
        ctx.onStatus?.({ phase: 'error', error: 'WhatsApp session expired. Pair this connection again.' });
        return;
      }
      ctx.onStatus?.({ phase: 'disconnected' });
      reconnectTimer = setTimeout(() => void startSocket().catch(reportError), 2_000);
    });
  };

  const reportError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    ctx.log('error', `whatsapp: ${message}`);
    ctx.onStatus?.({ phase: 'error', error: message });
  };

  return {
    type: 'whatsapp',
    capabilities: WHATSAPP_CAPABILITIES,
    async connect() {
      if (!stateDir) throw new Error('whatsapp: channel state directory is unavailable');
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      stopped = false;
      await startSocket();
    },
    async disconnect() {
      stopped = true;
      open = false;
      generation += 1;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      const current = socket;
      socket = undefined;
      if (current) await current.end(undefined).catch(() => {});
      ctx.onStatus?.({ phase: 'disconnected' });
    },
    async logout() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      await socket?.logout().catch(() => {});
    },
    async send(chatId: string, content: string): Promise<SentMessage> {
      const sent = await sendTracked(chatId, content);
      return { ref: sent?.key.id ?? `wa-${Date.now()}`, chatId };
    },
    async startTyping(chatId: string) {
      if (socket && open) await socket.sendPresenceUpdate('composing', chatId);
    }
  };
}

export const whatsappChannelAtom = defineChannel({
  type: 'whatsapp',
  name: 'WhatsApp',
  icon: channelIcons.whatsapp,
  setup: channelSetupGuides.whatsapp,
  connectionMode: 'pairing',
  capabilities: WHATSAPP_CAPABILITIES,
  envVars: [],
  create: createWhatsappAdapter
});
