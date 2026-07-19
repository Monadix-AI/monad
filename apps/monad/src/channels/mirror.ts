import type { SessionId } from '@monad/protocol';
import type { ChannelAdapter, ChannelLog } from '@monad/sdk-atom';
import type { ChannelLogger, ChannelTranslate } from '#/channels/types.ts';
import type { EventBus } from '#/services/event-bus.ts';

import { parseEventPayload } from '@monad/protocol';

import { errMsg } from '#/channels/helpers.ts';
import { type ChannelRenderMode, createRenderer } from '#/channels/render.ts';

export interface MirrorContext {
  sessionMirrors: Map<string, { channelId: string; unsubscribe: () => void }>;
  activeDispatches: Set<string>;
  bus: EventBus;
  log: ChannelLogger;
  t: ChannelTranslate;
  getRenderMode?(channelId: string, conversationKey: string, sessionId: SessionId): ChannelRenderMode;
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
  let currentRenderer: ReturnType<typeof createRenderer> | undefined;
  const unsubscribe = ctx.bus.subscribe(sessionId, (event) => {
    if (ctx.activeDispatches.has(sessionId)) return;
    switch (event.type) {
      case 'session.message.created': {
        const { message } = parseEventPayload('session.message.created', event.payload);
        if (message.role === 'user') {
          currentRenderer = undefined;
          break;
        }
        if (message.stream.status === 'pending' || message.stream.status === 'streaming') break;
        if (!currentRenderer) {
          currentRenderer = createRenderer({
            adapter,
            chatId,
            threadId,
            log,
            t,
            renderMode: ctx.getRenderMode?.(channelId, conversationKey, sessionId)
          });
        }
        currentRenderer.consume(event);
        const renderer = currentRenderer;
        currentRenderer = undefined;
        void renderer.finalize().catch((err: unknown) => log('warn', `finalize failed: ${errMsg(err)}`));
        break;
      }
      case 'session.message.delta.appended':
      case 'session.message.completed':
      case 'session.message.failed':
      case 'tool.approval_requested':
        if (event.type === 'session.message.completed' || event.type === 'session.message.failed') {
          const { message } = parseEventPayload(event.type, event.payload);
          if (message.role !== 'assistant') break;
        }
        if (!currentRenderer) {
          currentRenderer = createRenderer({
            adapter,
            chatId,
            threadId,
            log,
            t,
            renderMode: ctx.getRenderMode?.(channelId, conversationKey, sessionId)
          });
        }
        currentRenderer.consume(event);
        if (
          event.type === 'session.message.completed' ||
          event.type === 'session.message.failed' ||
          event.type === 'tool.approval_requested'
        ) {
          const r = currentRenderer;
          currentRenderer = undefined;
          void r.finalize().catch((err: unknown) => log('warn', `finalize failed: ${errMsg(err)}`));
        }
        break;
      default:
        break;
    }
  });

  ctx.sessionMirrors.set(sessionId, { channelId, unsubscribe });
}
