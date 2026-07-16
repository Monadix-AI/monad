// Renders an agent run's Event stream into platform messages on a ChannelAdapter. This is the
// ONLY place agent Events are turned into outbound calls — the atom pack never sees an Event, just
// the resulting content strings. Capability-gated: edit-capable channels stream via throttled
// edits; others buffer to one message per agent.message.

import type { StrictTranslateForNamespace } from '@monad/i18n';
import type { AgentMessagePayload, AgentTokenPayload, Event } from '@monad/protocol';
import type { ChannelAdapter, ChannelLog, SentMessage } from '@monad/sdk-atom';

import { channelTextRenderText, parseEventPayload } from '@monad/protocol';

const EDIT_THROTTLE_MS = 1200;

export interface Renderer {
  /** Feed one run event (matches EventSink). Side effects are enqueued, never awaited here. */
  consume(event: Event): void;
  /** Flush the trailing buffer / final edit. Awaits all enqueued platform I/O. */
  finalize(): Promise<void>;
}

export type ChannelRenderMode = 'detail' | 'summary';

export interface RendererOptions {
  adapter: ChannelAdapter;
  chatId: string;
  threadId?: string;
  log: ChannelLog;
  /** Active-locale translator for the notices this renderer emits (approval / error). */
  t: StrictTranslateForNamespace<'channel'>;
  /** Summary mode buffers token previews and only sends settled final messages to the channel. */
  renderMode?: ChannelRenderMode;
}

/**
 * Split text into chunks no longer than `max`, preferring a break at the last newline/space in the
 * upper half of the window (so words/lines aren't cut mid-token). Exported for tests.
 */
export function splitForLimit(text: string, max: number): string[] {
  if (text.length <= max) return text ? [text] : [];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const nl = window.lastIndexOf('\n');
    const sp = window.lastIndexOf(' ');
    const cut = nl >= max * 0.5 ? nl + 1 : sp >= max * 0.5 ? sp + 1 : max;
    const chunk = rest.slice(0, cut).replace(/\s+$/, '');
    if (chunk) parts.push(chunk);
    rest = rest.slice(cut);
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}

export function createRenderer({
  adapter,
  chatId,
  threadId,
  log,
  t,
  renderMode = 'detail'
}: RendererOptions): Renderer {
  const streaming = renderMode === 'detail' && adapter.capabilities.edit;
  const maxChars = adapter.capabilities.maxMessageChars;
  // Serialize all platform I/O so edits/sends keep order and finalize() can await the tail.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>): void => {
    chain = chain.then(fn).catch((err: unknown) => {
      log('warn', `channel render send failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  // Streaming-mode bubble state. `started` tracks draft creation SYNCHRONOUSLY — `handle` is
  // only assigned once the async send resolves, so consume() must not key off it.
  let started = false;
  let handle: SentMessage | undefined;
  let buf = '';
  let lastEditAt = 0;
  let typingStarted = false;

  const sendNew = (text: string): void => {
    for (const part of splitForLimit(text, maxChars)) {
      enqueue(async () => {
        await adapter.send(chatId, part, { threadId });
      });
    }
  };

  function onToken(p: AgentTokenPayload): void {
    if (!streaming) return; // buffered mode ignores tokens; agent.message carries the full text
    buf += p.delta;
    if (!typingStarted && adapter.capabilities.typing && adapter.startTyping) {
      const startTyping = adapter.startTyping;
      typingStarted = true;
      enqueue(() => startTyping(chatId, threadId));
    }
    if (!started) {
      started = true;
      lastEditAt = Date.now();
      const initial = buf;
      enqueue(async () => {
        handle = await adapter.send(chatId, initial || '…', { threadId });
      });
      return;
    }
    if (Date.now() - lastEditAt >= EDIT_THROTTLE_MS) {
      // Cap the in-progress preview at the platform limit; finalization splits the full text.
      const snapshot = buf.length > maxChars ? buf.slice(0, maxChars) : buf;
      lastEditAt = Date.now();
      enqueue(async () => {
        if (handle && adapter.editMessage) await adapter.editMessage(handle, snapshot);
      });
    }
  }

  function onMessage(p: AgentMessagePayload): void {
    const text = channelTextRenderText(p.text ?? '');
    if (streaming && started) {
      // Finalize the streamed bubble with the first chunk; any overflow goes to fresh messages so
      // the reply respects the platform's length limit (a too-long editMessage would be rejected).
      const [first = '', ...overflow] = splitForLimit(text || buf, maxChars);
      enqueue(async () => {
        if (handle && adapter.editMessage) await adapter.editMessage(handle, first);
      });
      for (const extra of overflow) sendNew(extra);
      started = false; // a following message starts a fresh bubble
      handle = undefined;
      buf = '';
      return;
    }
    sendNew(text); // buffered mode, or a message with no preceding token stream
  }

  return {
    consume(event: Event) {
      switch (event.type) {
        case 'agent.token':
          onToken(parseEventPayload('agent.token', event.payload));
          break;
        case 'agent.message':
          onMessage(parseEventPayload('agent.message', event.payload));
          break;
        case 'tool.approval_requested':
          // No trusted approver on a channel — the agent blocks; surface a notice, don't hang silently.
          sendNew(t('channel.approvalNeeded'));
          break;
        case 'agent.error': {
          const p = event.payload as { message: string; code?: string };
          const label = p.code ? `${p.code}: ${p.message}` : p.message;
          sendNew(t('channel.error', { label }));
          started = false;
          handle = undefined;
          buf = '';
          break;
        }
        default:
          break;
      }
    },
    async finalize() {
      // Streaming bubble that never got a terminal agent.message — flush what we have (chunked).
      if (streaming && started) {
        const [first = '', ...overflow] = splitForLimit(buf, maxChars);
        enqueue(async () => {
          if (handle && adapter.editMessage && first.trim()) await adapter.editMessage(handle, first);
        });
        for (const extra of overflow) sendNew(extra);
        started = false;
      }
      await chain;
    }
  };
}
