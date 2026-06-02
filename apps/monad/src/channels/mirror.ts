import type { SessionId } from '@monad/protocol';
import type { ChannelAdapter, ChannelLog } from '@monad/sdk-atom';
import type { ChannelLogger, ChannelTranslate } from '#/channels/types.ts';
import type { EventBus } from '#/services/event-bus.ts';

import { parseEventPayload } from '@monad/protocol';

import { errMsg } from '#/channels/helpers.ts';
import { type ChannelRenderMode, createRenderer } from '#/channels/render.ts';

const MAX_ACTIVE_RENDERERS = 64;

export interface MirrorContext {
  sessionMirrors: Map<string, { channelId: string; unsubscribe: () => void }>;
  activeDispatches: Set<string>;
  bus: EventBus;
  log: ChannelLogger;
  t: ChannelTranslate;
  getRenderMode?(channelId: string, conversationKey: string, sessionId: SessionId): ChannelRenderMode;
  isActiveBinding?(channelId: string, conversationKey: string, sessionId: SessionId): boolean;
}

/** Register an EventBus subscription that mirrors agent replies back to a channel chat.
 *  Only active when adapter.capabilities.outboundMirror is true. Idempotent. */
export function subscribeMirror(
  ctx: MirrorContext,
  channelId: string,
  conversationKey: string,
  sessionId: SessionId,
  adapter: ChannelAdapter
): void {
  if (!adapter.capabilities.outboundMirror) return;
  if (ctx.sessionMirrors.has(sessionId)) return;

  const parts = conversationKey.split('|');
  const chatId = parts[1];
  if (!chatId) return;
  const threadId = parts[2]?.startsWith('t:') ? parts[2].slice(2) : undefined;

  const log: ChannelLog = (level, msg) => ctx.log[level](`[${channelId}] mirror: ${msg}`);
  const t = ctx.t;
  const renderers = new Map<string, ReturnType<typeof createRenderer>>();
  const rendererFor = (messageId: string): ReturnType<typeof createRenderer> => {
    const existing = renderers.get(messageId);
    if (existing) return existing;
    if (renderers.size >= MAX_ACTIVE_RENDERERS) {
      const oldestId = renderers.keys().next().value;
      const oldest = oldestId ? renderers.get(oldestId) : undefined;
      if (oldestId) renderers.delete(oldestId);
      if (oldest) void oldest.finalize().catch((err: unknown) => log('warn', `finalize failed: ${errMsg(err)}`));
    }
    const renderer = createRenderer({
      adapter,
      chatId,
      threadId,
      log,
      t,
      renderMode: ctx.getRenderMode?.(channelId, conversationKey, sessionId)
    });
    renderers.set(messageId, renderer);
    return renderer;
  };
  const finalize = (messageId: string): void => {
    const renderer = renderers.get(messageId);
    if (!renderer) return;
    renderers.delete(messageId);
    void renderer.finalize().catch((err: unknown) => log('warn', `finalize failed: ${errMsg(err)}`));
  };
  const unsubscribe = ctx.bus.subscribe(sessionId, (event) => {
    if (ctx.isActiveBinding && !ctx.isActiveBinding(channelId, conversationKey, sessionId)) return;
    if (ctx.activeDispatches.has(sessionId)) return;
    switch (event.type) {
      case 'session.message.created': {
        const { message } = parseEventPayload('session.message.created', event.payload);
        if (message.role === 'user') break;
        if (message.stream.status === 'pending' || message.stream.status === 'streaming') break;
        rendererFor(message.id).consume(event);
        finalize(message.id);
        break;
      }
      case 'session.message.delta.appended': {
        const { messageId } = parseEventPayload('session.message.delta.appended', event.payload);
        rendererFor(messageId).consume(event);
        break;
      }
      case 'session.message.completed':
      case 'session.message.failed': {
        const { message } = parseEventPayload(event.type, event.payload);
        if (message.role !== 'assistant') break;
        rendererFor(message.id).consume(event);
        finalize(message.id);
        break;
      }
      case 'tool.approval_requested': {
        const renderer = createRenderer({ adapter, chatId, threadId, log, t });
        renderer.consume(event);
        void renderer.finalize().catch((err: unknown) => log('warn', `finalize failed: ${errMsg(err)}`));
        break;
      }
      default:
        break;
    }
  });

  ctx.sessionMirrors.set(sessionId, { channelId, unsubscribe });
}
