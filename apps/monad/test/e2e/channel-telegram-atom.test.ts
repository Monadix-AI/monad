// Dogfood: Telegram is a first-party ATOM PACK loaded through the SAME atom-kind-gated path
// (loadManifestAtomPack) as any third-party atom pack. Proves: (1) the unified loader yields the
// telegram factory, (2) the atom kind gate + sdkVersion check reject bad atom packs, (3) the
// atom-pack-sourced adapter runs end-to-end against a mock Bot API.

import { expect, test } from 'bun:test';
import { telegramChannelAtom } from '@monad/atoms/channels/telegram';
import { createI18n } from '@monad/i18n';
import { enMessages as i18nMessages } from '@monad/i18n/messages';
import { createChannelTestHarness, defineAtomPack, SDK_VERSION } from '@monad/sdk-atom';

import { loadChannelAtomPacks } from '@/channels/atom-pack-host.ts';
import { ChannelService } from '@/channels/channel.ts';
import { builtinChannelAdapters } from '@/channels/registry.ts';
import { MOCK_REPLY } from '@/infra/mock-model.ts';
import { EventBus } from '@/services/event-bus.ts';
import { createStore } from '@/store/db/index.ts';
import { buildHandlers, mockModel } from '../helpers.ts';

test('builtin loader yields the telegram channel through the atom pack path', async () => {
  const reg = await builtinChannelAdapters();
  expect(reg.has('telegram')).toBe(true);
  const factory = reg.get('telegram');
  if (!factory) throw new Error('factory not found');
  const h = createChannelTestHarness(factory, { secrets: { token: 't' } });
  expect(h.adapter.type).toBe('telegram');
  expect(h.adapter.capabilities.edit).toBe(true);
});

test('atom kind gate: an atom pack that omits the channel atom kind is rejected, no channel registered', async () => {
  const errors: { atomPack: string; error: unknown }[] = [];
  const sneaky = defineAtomPack({
    manifest: { name: 'sneaky', version: '1.0.0', sdkVersion: SDK_VERSION, atoms: [] },
    channels: [telegramChannelAtom]
  });
  const reg = await loadChannelAtomPacks([sneaky], { onError: (atomPack, error) => errors.push({ atomPack, error }) });
  expect(reg.size).toBe(0);
  expect(errors[0]?.atomPack).toBe('sneaky');
  expect((errors[0]?.error as Error).name).toBe('UndeclaredAtomError');
});

test('sdkVersion mismatch is rejected at load', async () => {
  const errors: string[] = [];
  const future = defineAtomPack({
    manifest: { name: 'future', version: '1.0.0', sdkVersion: '999', atoms: ['channel'] },
    channels: [telegramChannelAtom]
  });
  const reg = await loadChannelAtomPacks([future], { onError: (p) => errors.push(p) });
  expect(reg.size).toBe(0);
  expect(errors).toEqual(['future']);
});

// ── end-to-end: the atom-pack-sourced adapter drives a real run against a mock Bot API ──

const BOT_USER_ID = 4242;
const TESTER_ID = 777;

function startMockTelegram(): { url: string; outbound: string[]; stop: () => void } {
  const outbound: string[] = [];
  let served = false;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const method = new URL(req.url).pathname.split('/').pop() ?? '';
      const body = (await req.json().catch(() => ({}))) as { text?: string };
      const ok = (result: unknown) => Response.json({ ok: true, result });
      switch (method) {
        case 'getMe':
          return ok({ id: BOT_USER_ID, is_bot: true, username: 'dogfood' });
        case 'getUpdates':
          if (served) return ok([]);
          served = true;
          return ok([
            {
              update_id: 1,
              message: { message_id: 9, from: { id: TESTER_ID }, chat: { id: TESTER_ID, type: 'private' }, text: 'hi' }
            }
          ]);
        case 'sendMessage':
          outbound.push(body.text ?? '');
          return ok({ message_id: 1 });
        case 'editMessageText':
          outbound.push(body.text ?? '');
          return ok(true);
        default:
          return ok(true);
      }
    }
  });
  return { url: `http://127.0.0.1:${server.port}`, outbound, stop: () => server.stop(true) };
}

test('atom-pack-loaded telegram delivers an agent reply end-to-end (mock Bot API)', async () => {
  const tg = startMockTelegram();
  const handlers = buildHandlers(mockModel());
  const registry = await builtinChannelAdapters(); // factory comes from the ATOM PACK path
  const channelId = 'chn_DOGFOOD';

  const service = new ChannelService(
    {
      session: handlers.session,
      store: createStore(),
      registry,
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
          label: 'Dogfood',
          enabled: true,
          options: { apiBaseUrl: tg.url, pollTimeoutSec: 1 },
          allowlist: { allowAllUsers: false, allowedUsers: [String(TESTER_ID)] },
          mapping: { granularity: 'per-conversation' },
          ownerUsers: [],
          tokenRef: 'dogfood-token',
          rateLimitPerMin: 100
        }
      ]
    },
    { version: 1, activeProvider: null, updatedAt: '', credentialPool: {} }
  );

  try {
    await service.start();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !tg.outbound.some((t) => t.includes(MOCK_REPLY))) await Bun.sleep(25);
    expect(tg.outbound.some((t) => t.includes(MOCK_REPLY))).toBe(true);
  } finally {
    await service.stop();
    tg.stop();
  }
});
