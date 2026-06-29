// Smoke: the REAL Telegram adapter end-to-end, pointed at a local mock Bot API (no token,
// no network). Drives one inbound DM through getUpdates → ChannelService → session → mock
// agent → outbound sendMessage/editMessageText, and asserts the agent's reply lands back on
// the platform. Exercises the actual telegram.ts HTTP code path.

import { expect, test } from 'bun:test';
import { createI18n } from '@monad/i18n';
import { enMessages as i18nMessages } from '@monad/i18n/messages';

import { ChannelService } from '@/channels/channel.ts';
import { MOCK_REPLY } from '@/infra/mock-model.ts';
import { EventBus } from '@/services/event-bus.ts';
import { createStore } from '@/store/db/index.ts';
import { createTelegramAdapter } from '../../../../packages/atoms/src/channels/telegram.ts';
import { buildHandlers, mockModel } from '../helpers.ts';

const BOT_USER_ID = 4242;
const TESTER_ID = 777;

interface Outbound {
  method: string;
  text: string;
}

// A minimal Telegram Bot API double: getMe / getUpdates (one message, then empty) / send / edit.
function startMockTelegram(): { url: string; outbound: Outbound[]; stop: () => void } {
  const outbound: Outbound[] = [];
  let updateServed = false;

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const method = new URL(req.url).pathname.split('/').pop() ?? '';
      const body = (await req.json().catch(() => ({}))) as { text?: string };
      const ok = (result: unknown) => Response.json({ ok: true, result });

      switch (method) {
        case 'getMe':
          return ok({ id: BOT_USER_ID, is_bot: true, username: 'smokebot' });
        case 'getUpdates': {
          if (updateServed) return ok([]);
          updateServed = true;
          return ok([
            {
              update_id: 1,
              message: {
                message_id: 10,
                from: { id: TESTER_ID, username: 'tester' },
                chat: { id: TESTER_ID, type: 'private' },
                text: 'hello'
              }
            }
          ]);
        }
        case 'sendMessage':
          outbound.push({ method, text: body.text ?? '' });
          return ok({ message_id: 100 + outbound.length });
        case 'editMessageText':
          outbound.push({ method, text: body.text ?? '' });
          return ok(true);
        case 'sendChatAction':
          return ok(true);
        default:
          return ok(true);
      }
    }
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    outbound,
    stop: () => server.stop(true)
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(25);
  }
  return predicate();
}

test('telegram smoke: an allowlisted DM gets a mock-agent reply delivered back', async () => {
  const tg = startMockTelegram();
  const handlers = buildHandlers(mockModel());
  const mappingStore = createStore();

  const channelId = 'chn_SMOKE';
  const channelService = new ChannelService(
    {
      session: handlers.session,
      store: mappingStore,
      registry: new Map([['telegram', createTelegramAdapter]]),
      bus: new EventBus(),
      t: createI18n({ locale: 'en', packs: [{ locale: 'en', name: 'English', messages: i18nMessages }] }).t,
      log: { info: () => {}, warn: () => {}, error: () => {} }
    },
    {
      ...(await import('@monad/home')).createDefaultConfig('prn_OWNER', 'owner'),
      channels: [
        {
          id: channelId,
          type: 'telegram',
          label: 'Smoke',
          enabled: true,
          options: { apiBaseUrl: tg.url, pollTimeoutSec: 1 },
          allowlist: { allowAllUsers: false, allowedUsers: [String(TESTER_ID)] },
          mapping: { granularity: 'per-conversation' },
          ownerUsers: [],
          tokenRef: 'smoke-token',
          rateLimitPerMin: 100
        }
      ]
    },
    { version: 1, activeProvider: null, updatedAt: '', credentialPool: {} }
  );

  try {
    await channelService.start();

    // The reply is delivered once an outbound carries the mock model's full text.
    const delivered = await waitFor(() => tg.outbound.some((o) => o.text.includes(MOCK_REPLY)));
    expect(delivered).toBe(true);

    // Exactly one conversation was bound for this chat (core-owned mapping).
    expect(mappingStore.countActiveConversations(channelId)).toBe(1);
    const conv = mappingStore.getActiveConversation(channelId, `${channelId}|${TESTER_ID}`);
    expect(conv?.activeSessionId).toMatch(/^ses_/);
    expect(conv?.principalId).toBe('prn_SMOKE'); // synthetic, not the owner
  } finally {
    await channelService.stop();
    tg.stop();
  }
});
