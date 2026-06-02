// Smoke: the REAL Telegram adapter end-to-end, pointed at a local mock Bot API (no token,
// no network). Drives one inbound DM through getUpdates → ChannelService → session → mock
// agent → outbound sendMessage/editMessageText, and asserts the agent's reply lands back on
// the platform. Exercises the actual telegram.ts HTTP code path.

import { expect, test } from 'bun:test';
import { createTelegramAdapter } from '@monad/atoms/channels/telegram';
import { createDefaultConfig, emptyAuth } from '@monad/environment';
import { createI18n } from '@monad/i18n';
import { enMessages as i18nMessages } from '@monad/i18n/messages';

import { ChannelService } from '#/channels/channel.ts';
import { MOCK_REPLY } from '#/infra/mock-model.ts';
import { EventBus } from '#/services/event-bus.ts';
import { createStore } from '#/store/db/index.ts';
import { buildHandlers, mockModel, stubConfigAccess } from '../helpers.ts';

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

test('telegram smoke: a DM gets a mock-agent reply delivered back', async () => {
  const tg = startMockTelegram();
  const mappingStore = createStore();
  const directAgentId = 'agt_SMOKEDIRECT0';
  const cfg = createDefaultConfig('owner');
  cfg.agent.agents = [
    {
      id: directAgentId,
      name: 'Smoke',
      capabilities: [],
      credentialIds: [],
      declaredScopes: [],
      memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 },
      atoms: { mode: 'inherit', allow: [], deny: [] },
      visibility: { subagentCallable: false, public: false },
      a2a: { enabled: false },
      monadix: { consume: false }
    }
  ];
  cfg.channels = [
    {
      id: 'chn_SMOKE0000000',
      type: 'telegram',
      label: 'Smoke',
      enabled: true,
      mapping: { granularity: 'per-conversation' },
      agentId: directAgentId,
      credential: { token: 'smoke-token', extra: { apiBaseUrl: tg.url, pollTimeoutSec: '1' } },
      rateLimitPerMin: 100
    }
  ];
  const handlers = buildHandlers(mockModel(), undefined, { configManager: stubConfigAccess(cfg) });

  const channelId = 'chn_SMOKE0000000';
  const channelService = new ChannelService(
    {
      session: handlers.session,
      store: mappingStore,
      registry: new Map([['telegram', createTelegramAdapter]]),
      bus: new EventBus(),
      t: createI18n({ locale: 'en', packs: [{ locale: 'en', name: 'English', messages: i18nMessages }] }).t,
      log: { info: () => {}, warn: () => {}, error: () => {} }
    },
    cfg,
    emptyAuth()
  );

  try {
    await channelService.start();

    // The reply is delivered once an outbound carries the mock model's full text.
    await waitFor(() => tg.outbound.some((o) => o.text.includes(MOCK_REPLY)), 3000);
    expect(tg.outbound.map((outbound) => outbound.text)).toEqual(
      expect.arrayContaining([expect.stringContaining(MOCK_REPLY)])
    );

    // Exactly one conversation was bound for this chat (core-owned mapping).
    expect(mappingStore.countActiveConversations(channelId)).toBe(1);
    const conv = mappingStore.getActiveConversation(channelId, `${channelId}|${TESTER_ID}`);
    expect(conv?.activeSessionId).toMatch(/^ses_/);
  } finally {
    await channelService.stop();
    tg.stop();
  }
});
