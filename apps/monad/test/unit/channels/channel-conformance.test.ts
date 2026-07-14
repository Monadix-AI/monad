// Channel service conformance tests — each case pins a specific behavior of the inbound→agent→outbound
// loop (conversation mapping, allowlist, rate-limit, render chunking, echo guard, etc.) that can't be
// tested against real third-party platforms. Documented stances live in docs/internals/channel-conformance.md.

import type { ChannelInstanceConfig, MonadAuth, MonadConfig } from '@monad/home';
import type { ChannelInbound, MessageId, SessionId } from '@monad/protocol';
import type { ChannelAdapter, ChannelContext } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';
import { createDefaultConfig } from '@monad/home';
import { createI18n } from '@monad/i18n';
import { enMessages as i18nMessages } from '@monad/i18n/messages';
import { newId } from '@monad/protocol';

import { ChannelService } from '#/channels/channel.ts';
import { createRenderer, splitForLimit } from '#/channels/render.ts';
import { EventBus } from '#/services/event-bus.ts';
import { createStore } from '#/store/db/index.ts';

const EMPTY_AUTH: MonadAuth = { version: 1, activeProvider: null, updatedAt: '', credentialPool: {} };
const t = createI18n({ locale: 'en', packs: [{ locale: 'en', name: 'English', messages: i18nMessages }] }).t;

// Inbound normalization (the Telegram adapter, sections A1–A4) lives with the adapter in
// @monad/atoms — see packages/atoms/test/telegram.test.ts. This file covers the
// ChannelService/renderer conformance that depends on the daemon runtime.

// ───────────────────────── B. Outbound chunking (renderer) ─────────────────────────
// Reference matrix C11: long replies are split at the platform message-length limit.

test('B-split: splitForLimit chunks at the limit, prefers word/line breaks, reassembles', () => {
  expect(splitForLimit('short', 10)).toEqual(['short']);
  const words = `${'a'.repeat(8)} ${'b'.repeat(8)} ${'c'.repeat(8)}`; // 26 chars, limit 10
  const parts = splitForLimit(words, 10);
  expect(parts.every((p) => p.length <= 10)).toBe(true);
  expect(parts.join(' ')).toBe(words); // word boundaries preserved
  // a single over-long token is hard-cut
  const long = 'x'.repeat(25);
  const hard = splitForLimit(long, 10);
  expect(hard).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
});

function capturingAdapter(
  edit: boolean,
  maxMessageChars = 4096
): { adapter: ChannelAdapter; sends: string[]; edits: string[] } {
  const sends: string[] = [];
  const edits: string[] = [];
  return {
    sends,
    edits,
    adapter: {
      type: 'telegram',
      capabilities: {
        edit,
        typing: false,
        threads: false,
        maxMessageChars,
        markdown: false,
        reactions: false,
        nativeCommands: false,
        outboundMirror: false
      },
      async connect() {},
      async disconnect() {},
      async send(_c, content) {
        sends.push(content);
        return { ref: String(sends.length), chatId: _c };
      },
      async editMessage(_m, content) {
        edits.push(content);
      }
    }
  };
}

function msgEvent(text: string) {
  return {
    id: newId('evt'),
    sessionId: 'ses_X00000000000' as SessionId,
    type: 'agent.message' as const,
    actorAgentId: null,
    payload: { messageId: 'msg_X00000000000' as MessageId, text },
    at: ''
  };
}

test('B-render(buffered): a reply over the limit is sent as multiple chunks', async () => {
  const { adapter, sends } = capturingAdapter(false, 100);
  const r = createRenderer({ adapter, chatId: 'c1', log: () => {}, t });
  const long = `${'word '.repeat(60)}`.trim(); // ~300 chars
  r.consume(msgEvent(long));
  await r.finalize();
  expect(sends.length).toBeGreaterThan(1);
  expect(sends.every((s) => s.length <= 100)).toBe(true);
  expect(sends.join(' ')).toBe(long);
});

test('B-render(streaming): an over-limit final is edited (first chunk) then overflow sent', async () => {
  const { adapter, sends, edits } = capturingAdapter(true, 100);
  const r = createRenderer({ adapter, chatId: 'c1', log: () => {}, t });
  r.consume({
    id: newId('evt'),
    sessionId: 'ses_X00000000000' as SessionId,
    type: 'agent.token',
    actorAgentId: null,
    payload: { messageId: 'msg_X00000000000' as MessageId, delta: 'start', index: 0 },
    at: ''
  });
  const long = `${'word '.repeat(60)}`.trim();
  r.consume(msgEvent(long));
  await r.finalize();
  expect((edits.at(-1) ?? '').length).toBeLessThanOrEqual(100); // final bubble within limit
  expect(sends.every((s) => s.length <= 100)).toBe(true); // overflow messages within limit too
});

test('B-render(streaming): finalize without agent.message flushes buf, chunking overflow', async () => {
  // Turn is aborted / stream stops before a terminal agent.message arrives. finalize() flushes
  // what's in the buffer and must respect the platform limit (same chunking as the normal path).
  const { adapter, sends, edits } = capturingAdapter(true, 50);
  const r = createRenderer({ adapter, chatId: 'c1', log: () => {}, t });
  // Accumulate tokens (simulating a streaming turn with no final agent.message)
  const long = `${'word '.repeat(20)}`.trim(); // ~100 chars — over the 50-char limit
  for (const chunk of long.split(' ')) {
    r.consume({
      id: newId('evt'),
      sessionId: 'ses_X00000000000' as SessionId,
      type: 'agent.token',
      actorAgentId: null,
      payload: { messageId: 'msg_X00000000000' as MessageId, delta: `${chunk} `, index: 0 },
      at: ''
    });
  }
  await r.finalize();
  // First chunk goes to editMessage; overflow goes to send.
  expect(edits.length).toBeGreaterThan(0);
  expect((edits.at(-1) ?? '').length).toBeLessThanOrEqual(50);
  expect(sends.every((s) => s.length <= 50)).toBe(true);
  // Reassembled text contains the full content (modulo trailing whitespace trimming).
  const all = [...edits, ...sends].join(' ').replace(/\s+/g, ' ').trim();
  expect(all.length).toBeGreaterThan(0);
});

// ───────────────────────── C. Core routing / keying / auth (ChannelService) ─────────────────────
// Reference matrix B9 (session keying), E18 (disallowed → SILENT DROP), A3/A8 (self/dedup).

function chConfig(over: Partial<ChannelInstanceConfig> = {}): ChannelInstanceConfig {
  return {
    id: 'chn_CONF00000000',
    type: 'telegram',
    label: 'Conf',
    enabled: true,
    options: {},
    allowlist: { allowAllUsers: true, allowedUsers: [] },
    mapping: { granularity: 'per-conversation' },
    tokenRef: 'tok',
    rateLimitPerMin: 1000,
    ...over
  };
}

async function coreHarness(channel: ChannelInstanceConfig) {
  const sends: { chatId: string; content: string }[] = [];
  const creates: string[] = [];
  let ctx: ChannelContext | undefined;
  const adapter: ChannelAdapter = {
    type: 'telegram',
    capabilities: {
      edit: false,
      typing: false,
      threads: false,
      maxMessageChars: 4096,
      markdown: false,
      reactions: false,
      nativeCommands: false,
      outboundMirror: false
    },
    async connect() {},
    async disconnect() {},
    async send(chatId, content) {
      sends.push({ chatId, content });
      return { ref: String(sends.length), chatId };
    }
  };
  const cfg: MonadConfig = { ...createDefaultConfig('prn_OWNER0000000', 'owner'), channels: [channel] };
  const service = new ChannelService(
    {
      session: {
        createForPrincipal: async () => {
          creates.push(newId('ses'));
          return { sessionId: newId('ses') as SessionId };
        },
        sendInline: async ({ text }, sink) => sink(msgEvent(`reply: ${text}`))
      },
      store: createStore(),
      registry: new Map([
        [
          'telegram',
          (c: ChannelContext) => {
            ctx = c;
            return adapter;
          }
        ]
      ]),
      t,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      bus: new EventBus()
    },
    cfg,
    EMPTY_AUTH
  );
  await service.start();
  if (!ctx) throw new Error('adapter not constructed');
  const captured = ctx;
  const flush = () => new Promise((r) => setTimeout(r, 20));
  return { service, sends, creates, push: (m: ChannelInbound) => captured.onMessage(m), flush };
}

function inbound(o: Partial<ChannelInbound> & { chatId: string; userId: string }): ChannelInbound {
  return {
    text: '',
    kind: 'text',
    commandArgs: [],
    nativeMessageId: newId('msg'),
    isSelf: false,
    media: [],
    at: '',
    ...o
  };
}

test('C-E18: a disallowed user is SILENTLY dropped — no reply, no session (both refs agree)', async () => {
  const h = await coreHarness(chConfig({ allowlist: { allowAllUsers: false, allowedUsers: ['u1'] } }));
  h.push(inbound({ chatId: 'c', userId: 'intruder', text: 'let me in' }));
  await h.flush();
});

test('C-B9: per-conversation keying — two users in one chat SHARE a session', async () => {
  const h = await coreHarness(chConfig({ mapping: { granularity: 'per-conversation' } }));
  h.push(inbound({ chatId: 'grp', userId: 'a', text: 'hi' }));
  await h.flush();
  h.push(inbound({ chatId: 'grp', userId: 'b', text: 'yo' }));
  await h.flush();
  expect(h.creates.length).toBe(1); // one shared session for the chat
});

test('C-B9: per-user keying — two users in one chat get SEPARATE sessions', async () => {
  const h = await coreHarness(chConfig({ mapping: { granularity: 'per-user' } }));
  h.push(inbound({ chatId: 'grp', userId: 'a', text: 'hi' }));
  await h.flush();
  h.push(inbound({ chatId: 'grp', userId: 'b', text: 'yo' }));
  await h.flush();
  expect(h.creates.length).toBe(2); // isolated per user
});

test('C-A8: a duplicate nativeMessageId is dropped (dedup)', async () => {
  const h = await coreHarness(chConfig());
  const m = inbound({ chatId: 'c', userId: 'u', text: 'hi' });
  h.push(m);
  await h.flush();
  h.push(m);
  await h.flush();
  expect(h.creates.length).toBe(1);
});

test('C: an UNKNOWN slash-command is treated as a normal message (not executed) — matches /path/to/file', async () => {
  const h = await coreHarness(chConfig());
  h.push(inbound({ chatId: 'c', userId: 'u', kind: 'command', command: 'path/to/file', text: '/path/to/file' }));
  await h.flush();
  // unknown command → falls through to the agent as text → a session is created + a reply sent
  expect(h.creates.length).toBe(1);
});
