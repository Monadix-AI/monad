import type { ChannelInstanceConfig, MonadAuth, MonadConfig } from '@monad/home';
import type { ChannelInbound, Event, MessageId, SessionId } from '@monad/protocol';
import type { ChannelAdapter, ChannelContext, SentMessage } from '@monad/sdk-atom';
import type { CommandBundle } from '@/handlers/commands/index.ts';

import { expect, test } from 'bun:test';
import { createDefaultConfig } from '@monad/home';
import { createI18n } from '@monad/i18n';
import { enMessages as i18nMessages } from '@monad/i18n/messages';
import { channelDisplayText, newId, principalIdSchema } from '@monad/protocol';

import { ChannelService, sweepIdleBuckets } from '@/channels/channel.ts';
import { createRenderer } from '@/channels/render.ts';
import { EventBus } from '@/services/event-bus.ts';
import { createStore } from '@/store/db/index.ts';
import { seededCommandRegistry } from '../../helpers.ts';

/** A real English translator so command/channel replies read as before (assertions check English). */
const t = createI18n({ locale: 'en', packs: [{ locale: 'en', name: 'English', messages: i18nMessages }] }).t;

/** A command bundle for the channel harness: the real built-in registry + inert model/compact hooks. */
function testCommandBundle(): CommandBundle {
  return {
    registry: seededCommandRegistry(),
    skills: () => [],
    listModels: async () => [{ alias: 'fast', provider: 'p', modelId: 'm', current: true }],
    setModel: async () => {},
    compact: async () => ({ compacted: 0 }),
    consolidateMemory: async () => [],
    handoff: async () => ({ sessionId: 'ses_new' as SessionId }),
    consolidateGraph: async () => ({ sessionsExtracted: 0, nodes: 0, edges: 0, prunedEdges: 0 }),
    t,
    log: () => {}
  };
}

test('sweepIdleBuckets drops fully-refilled buckets and keeps actively-throttled ones', () => {
  const limit = 60; // 60/min = 1 token/sec refill
  const now = 1_000_000;
  const buckets = new Map<string, { tokens: number; last: number }>([
    ['idle-full', { tokens: limit, last: now - 10_000 }], // already full
    ['idle-recovered', { tokens: 0, last: now - 120_000 }], // 2 min idle → refills past limit
    ['throttled', { tokens: 0, last: now - 1_000 }] // 1s ago → only ~1 token back, still < limit
  ]);

  sweepIdleBuckets(buckets, now, limit);

  expect(buckets.has('idle-full')).toBe(false);
  expect(buckets.has('idle-recovered')).toBe(false);
  expect(buckets.has('throttled')).toBe(true); // a user mid-throttle must not be reset
});

test('sweepIdleBuckets is a no-op when every bucket is still throttled', () => {
  const limit = 10;
  const now = 2_000_000;
  const buckets = new Map<string, { tokens: number; last: number }>([
    ['a', { tokens: 0, last: now }],
    ['b', { tokens: 2, last: now }]
  ]);
  sweepIdleBuckets(buckets, now, limit);
  expect(buckets.size).toBe(2);
});

const EMPTY_AUTH: MonadAuth = { version: 1, activeProvider: null, updatedAt: '', credentialPool: {} };

function tokenEvent(delta: string, index: number): Event {
  return {
    id: newId('evt'),
    sessionId: 'ses_X' as SessionId,
    type: 'agent.token',
    actorAgentId: null,
    payload: { messageId: 'msg_X' as MessageId, delta, index },
    at: ''
  };
}
function messageEvent(text: string): Event {
  return {
    id: newId('evt'),
    sessionId: 'ses_X' as SessionId,
    type: 'agent.message',
    actorAgentId: null,
    payload: { messageId: 'msg_X' as MessageId, text },
    at: ''
  };
}

// ---------- renderer ----------

function makeCapturingAdapter(edit: boolean): {
  adapter: ChannelAdapter;
  sends: string[];
  edits: string[];
} {
  const sends: string[] = [];
  const edits: string[] = [];
  const adapter: ChannelAdapter = {
    type: 'telegram',
    capabilities: {
      edit,
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
    async send(_chatId, content): Promise<SentMessage> {
      sends.push(content);
      return { ref: String(sends.length), chatId: _chatId };
    },
    async editMessage(_msg, content) {
      edits.push(content);
    }
  };
  return { adapter, sends, edits };
}

test('renderer (buffered): emits one message per agent.message', async () => {
  const { adapter, sends } = makeCapturingAdapter(false);
  const r = createRenderer({ adapter, chatId: 'c1', log: () => {}, t });
  r.consume(tokenEvent('hel', 0)); // ignored in buffered mode
  r.consume(tokenEvent('lo', 1));
  r.consume(messageEvent('hello world'));
  await r.finalize();
  expect(sends).toEqual(['hello world']);
});

test('renderer: structured channel response renders only display content', async () => {
  const { adapter, sends } = makeCapturingAdapter(false);
  const r = createRenderer({ adapter, chatId: 'c1', log: () => {}, t });
  r.consume(
    messageEvent(
      JSON.stringify({
        display: { kind: 'markdown', content: 'visible update' },
        attachments: [{ kind: 'note', text: 'metadata' }],
        next: [{ agentId: 'agt_NEXT', prompt: 'do work' }]
      })
    )
  );
  await r.finalize();
  expect(sends).toEqual(['visible update\n\nAttachments:\n- note']);
});

test('channelDisplayText falls back to raw text for legacy replies', () => {
  expect(channelDisplayText('plain reply')).toBe('plain reply');
  expect(channelDisplayText('```json\n{"display":{"content":"from fence"}}\n```')).toBe('from fence');
  expect(channelDisplayText('{"visibility":"silent","display":{"content":"hidden"},"attachments":[],"next":[]}')).toBe(
    ''
  );
});

test('renderer (streaming): sends a draft then edits to the final text', async () => {
  const { adapter, sends, edits } = makeCapturingAdapter(true);
  const r = createRenderer({ adapter, chatId: 'c1', log: () => {}, t });
  r.consume(tokenEvent('hel', 0));
  r.consume(tokenEvent('lo', 1));
  r.consume(messageEvent('hello world'));
  await r.finalize();
  expect(sends.length).toBe(1); // a single draft bubble
  expect(edits.at(-1)).toBe('hello world'); // finalized to the authoritative text
});

test('renderer: agent.error surfaces an error message and resets stream state', async () => {
  const { adapter, sends } = makeCapturingAdapter(true);
  const r = createRenderer({ adapter, chatId: 'c1', log: () => {}, t });
  r.consume(tokenEvent('partial', 0)); // start a streaming bubble
  r.consume({
    id: newId('evt'),
    sessionId: 'ses_X' as SessionId,
    type: 'agent.error',
    actorAgentId: null,
    payload: { message: 'upstream 503', code: '503' },
    at: ''
  });
  await r.finalize(); // finalize should not flush the abandoned bubble
  expect(sends.some((s) => s.includes('⚠') && s.includes('503') && s.includes('upstream 503'))).toBe(true);
  // The next message starts a fresh bubble (stream state was reset by agent.error)
  const countBefore = sends.length;
  r.consume(tokenEvent('fresh', 0));
  r.consume(messageEvent('fresh message'));
  await r.finalize();
  expect(sends.length).toBeGreaterThan(countBefore); // fresh bubble sent
});

test('renderer: agent.error without code still includes the message', async () => {
  const { adapter, sends } = makeCapturingAdapter(false);
  const r = createRenderer({ adapter, chatId: 'c1', log: () => {}, t });
  r.consume({
    id: newId('evt'),
    sessionId: 'ses_X' as SessionId,
    type: 'agent.error',
    actorAgentId: null,
    payload: { message: 'something broke' },
    at: ''
  });
  await r.finalize();
  expect(sends.some((s) => s.includes('something broke') && !s.includes('undefined'))).toBe(true);
});

test('renderer: surfaces an approval notice (no channel approver)', async () => {
  const { adapter, sends } = makeCapturingAdapter(false);
  const r = createRenderer({ adapter, chatId: 'c1', log: () => {}, t });
  r.consume({
    id: newId('evt'),
    sessionId: 'ses_X' as SessionId,
    type: 'tool.approval_requested',
    actorAgentId: null,
    payload: {},
    at: ''
  });
  await r.finalize();
  expect(sends.length).toBe(1);
  expect(sends[0]).toContain('approve');
});

// ---------- ChannelService (mock adapter) ----------

interface Harness {
  service: ChannelService;
  ctx: ChannelContext;
  sends: { chatId: string; content: string }[];
  creates: { title: string; principalId: string; agentId?: string; origin?: unknown }[];
  reactions: { messageId: string; emoji: string }[];
  logs: { level: 'info' | 'warn' | 'error'; message: string }[];
  store: ReturnType<typeof createStore>;
  flush(): Promise<void>;
}

function channelConfig(over: Partial<ChannelInstanceConfig> = {}): ChannelInstanceConfig {
  return {
    id: 'chn_TESTCHANNEL',
    type: 'telegram',
    label: 'Test',
    enabled: true,
    options: {},
    allowlist: { allowAllUsers: false, allowedUsers: ['u1'] },
    mapping: { granularity: 'per-conversation' },
    ownerUsers: [],
    tokenRef: 'literal-token',
    rateLimitPerMin: 100,
    ...over
  };
}

function testAgent(id: `agt_${string}`, name: string): MonadConfig['agent']['agents'][number] {
  return {
    id,
    name,
    capabilities: [],
    declaredScopes: [],
    atoms: { mode: 'inherit', allow: [], deny: [] },
    visibility: { subagentCallable: false, public: false }
  };
}

async function makeHarness(
  channel: ChannelInstanceConfig,
  commands: CommandBundle = testCommandBundle(),
  agents: MonadConfig['agent']['agents'] = [],
  sendInline: HarnessSendInline = async ({ text }, sink) => {
    sink(messageEvent(`reply: ${text}`));
  },
  moderatorTaskTimeoutMs?: number,
  setupStore?: (store: ReturnType<typeof createStore>) => void
): Promise<Harness> {
  const store = createStore();
  const sends: Harness['sends'] = [];
  const creates: Harness['creates'] = [];
  const reactions: Harness['reactions'] = [];
  const logs: Harness['logs'] = [];
  let captured: ChannelContext | undefined;

  const adapter: ChannelAdapter = {
    type: 'telegram',
    capabilities: {
      edit: false,
      typing: false,
      threads: false,
      maxMessageChars: 4096,
      markdown: false,
      reactions: true,
      nativeCommands: false,
      outboundMirror: false
    },
    async connect() {},
    async disconnect() {},
    async send(chatId, content) {
      sends.push({ chatId, content });
      return { ref: String(sends.length), chatId };
    },
    async react(target, emoji) {
      reactions.push({ messageId: target.messageId, emoji });
    }
  };

  const cfg: MonadConfig = { ...createDefaultConfig('prn_OWNER', 'owner'), channels: [channel] };
  cfg.agent.agents = agents;
  setupStore?.(store);
  const service = new ChannelService(
    {
      session: {
        createForPrincipal: async ({ title, principalId, agentId, origin }) => {
          creates.push({ title, principalId, agentId, origin });
          return { sessionId: newId('ses') };
        },
        sendInline,
        reset: async () => ({ clearedCount: 0 })
      },
      store,
      registry: new Map([
        [
          'telegram',
          (c: ChannelContext) => {
            captured = c;
            return adapter;
          }
        ]
      ]),
      commands,
      moderatorTaskTimeoutMs,
      t,
      log: {
        info: (message) => logs.push({ level: 'info', message }),
        warn: (message) => logs.push({ level: 'warn', message }),
        error: (message) => logs.push({ level: 'error', message })
      },
      bus: new EventBus()
    },
    cfg,
    EMPTY_AUTH
  );

  await service.start();
  if (!captured) throw new Error('adapter was not constructed');

  return {
    service,
    ctx: captured,
    sends,
    creates,
    reactions,
    logs,
    store,
    flush: () => new Promise((r) => setTimeout(r, 20))
  };
}

type HarnessSendInline = (
  args: { sessionId: SessionId; text: string },
  sink: (event: Event) => void,
  runOpts?: { transport?: string }
) => Promise<void>;

function inbound(over: Partial<ChannelInbound> & { chatId: string; userId: string }): ChannelInbound {
  return {
    text: '',
    kind: 'text',
    commandArgs: [],
    nativeMessageId: newId('msg'),
    isSelf: false,
    media: [],
    at: '',
    ...over
  };
}

test('channel: the adapter context is hard-isolated from session/host internals', async () => {
  const h = await makeHarness(channelConfig());
  // The atom pack must not be able to reach sessions, the store, the bus, or a sessionId.
  expect('handlers' in h.ctx).toBe(false);
  expect('store' in h.ctx).toBe(false);
  expect('bus' in h.ctx).toBe(false);
  expect('sessionId' in h.ctx).toBe(false);
  expect(typeof h.ctx.onMessage).toBe('function');
});

test('channel: an allowed inbound creates a session with a SYNTHETIC principal (not owner)', async () => {
  const h = await makeHarness(channelConfig());
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', text: 'hi' }));
  await h.flush();

  expect(h.creates.length).toBe(1);
  expect(h.creates[0]?.principalId).toBe('prn_TESTCHANNEL'); // derived from the channel id
  expect(h.creates[0]?.principalId).not.toBe('prn_OWNER');
  expect(h.sends.at(-1)).toEqual({ chatId: 'chat1', content: 'reply: hi' });
});

test('channel: the synthetic principal is always a schema-valid PrincipalId, even for a non-ULID id', async () => {
  // A channel id with underscores/lowercase (config schema permits any `chn_*`) must still yield a
  // `prn_[A-Z0-9]+` principal — otherwise the whole session-list response fails validation.
  const h = await makeHarness(channelConfig({ id: 'chn_DEV_Telegram' }));
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', text: 'hi' }));
  await h.flush();

  const principalId = h.creates[0]?.principalId;
  expect(principalId).toBe('prn_DEVTELEGRAM');
  expect(() => principalIdSchema.parse(principalId)).not.toThrow();
});

test('channel: a second inbound from the same chat REUSES the session', async () => {
  const h = await makeHarness(channelConfig());
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', text: 'one' }));
  await h.flush();
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', text: 'two' }));
  await h.flush();
  expect(h.creates.length).toBe(1); // only one session ever created for this conversation
});

test('channel: different chats get isolated sessions', async () => {
  const h = await makeHarness(channelConfig({ allowlist: { allowAllUsers: true, allowedUsers: [] } }));
  h.ctx.onMessage(inbound({ chatId: 'chatA', userId: 'a', text: 'x' }));
  await h.flush();
  h.ctx.onMessage(inbound({ chatId: 'chatB', userId: 'b', text: 'y' }));
  await h.flush();
  expect(h.creates.length).toBe(2);
});

test('channel: /new repoints to a fresh session, /switch lists work', async () => {
  const h = await makeHarness(channelConfig());
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', text: 'first' }));
  await h.flush();
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', kind: 'command', command: 'new', text: '/new' }));
  await h.flush();
  expect(h.creates.length).toBe(2); // original + the /new session
  expect(h.sends.at(-1)?.content).toContain('new conversation');

  // a following message uses the NEW session, not the first
  const before = h.creates.length;
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', text: 'third' }));
  await h.flush();
  expect(h.creates.length).toBe(before); // reused the /new session
});

test('channel: unified registry adds /reset and /help to a channel', async () => {
  const h = await makeHarness(channelConfig(), testCommandBundle());
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', text: 'first' }));
  await h.flush();
  const before = h.sends.length;

  // /reset is a host built-in — it reaches the channel, replies with text, AND ✅-reacts the command.
  h.ctx.onMessage(
    inbound({
      chatId: 'chat1',
      userId: 'u1',
      kind: 'command',
      command: 'reset',
      text: '/reset',
      nativeMessageId: 'cmd-reset'
    })
  );
  await h.flush();
  expect(h.sends.at(-1)?.content).toContain('Cleared');
  expect(h.reactions).toContainEqual({ messageId: 'cmd-reset', emoji: '✅' });

  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', kind: 'command', command: 'help', text: '/help' }));
  await h.flush();
  expect(h.sends.at(-1)?.content).toContain('/reset');
  expect(h.sends.length).toBeGreaterThan(before);
});

test('channel: an effect-only command (/clear) only reacts — no text reply, but a clear receipt', async () => {
  const h = await makeHarness(channelConfig());
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', text: 'first' }));
  await h.flush();
  const before = h.sends.length;

  h.ctx.onMessage(
    inbound({
      chatId: 'chat1',
      userId: 'u1',
      kind: 'command',
      command: 'clear',
      text: '/clear',
      nativeMessageId: 'cmd-clear'
    })
  );
  await h.flush();
  expect(h.sends.length).toBe(before); // no text bubble for an effect-only command
  expect(h.reactions).toContainEqual({ messageId: 'cmd-clear', emoji: '✅' }); // …but a ✅ receipt
});

test('channel: an unknown command falls through to the agent as plain text', async () => {
  const h = await makeHarness(channelConfig(), testCommandBundle());
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', kind: 'command', command: 'bogus', text: '/bogus' }));
  await h.flush();
  // No host command claimed it → routed to the agent, which echoes "reply: …", and NOT ✅-reacted.
  expect(h.sends.at(-1)?.content).toContain('reply:');
  expect(h.reactions).toHaveLength(0);
});

test('channel: default-deny drops an unauthorized user (no session, no reply)', async () => {
  const h = await makeHarness(channelConfig({ allowlist: { allowAllUsers: false, allowedUsers: ['u1'] } }));
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'intruder', text: 'let me in' }));
  await h.flush();
  expect(h.creates.length).toBe(0);
  expect(h.sends.length).toBe(0);
});

test('channel: an owner-only command (/workdir) is refused to a non-owner user', async () => {
  const h = await makeHarness(channelConfig()); // ownerUsers: [] → u1 is allowed but not an owner
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', kind: 'command', command: 'workdir', text: '/workdir' }));
  await h.flush();
  expect(h.sends.at(-1)?.content).toContain('owner-only');
});

test('channel: an owner-only command (/workdir) runs for a user in ownerUsers', async () => {
  const h = await makeHarness(channelConfig({ ownerUsers: ['u1'] }));
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', kind: 'command', command: 'workdir', text: '/workdir' }));
  await h.flush();
  // Gate passed → the show-mode reply ran (no folder set yet), never the owner-only refusal.
  expect(h.sends.at(-1)?.content).not.toContain('owner-only');
  expect(h.sends.at(-1)?.content?.toLowerCase()).toContain('working folder');
});

test('channel: self-echo and duplicate messages are dropped', async () => {
  const h = await makeHarness(channelConfig());
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', text: 'echo', isSelf: true }));
  await h.flush();
  expect(h.creates.length).toBe(0);

  const dup = inbound({ chatId: 'chat1', userId: 'u1', text: 'hi' });
  h.ctx.onMessage(dup);
  await h.flush();
  h.ctx.onMessage(dup); // same nativeMessageId → deduped
  await h.flush();
  expect(h.creates.length).toBe(1);
});

test('channel: status snapshot never leaks token material', async () => {
  const h = await makeHarness(channelConfig({ tokenRef: 'super-secret-token' }));
  const [status] = h.service.statusSnapshot();
  expect(status).toBeDefined();
  expect(JSON.stringify(status)).not.toContain('super-secret-token');
  expect(status?.hasToken).toBe(true);
});

test('channel: setRegistry disconnects a running channel whose adapter type vanished', async () => {
  const h = await makeHarness(channelConfig({ allowlist: { allowAllUsers: true, allowedUsers: [] } }));
  expect(h.service.statusSnapshot()[0]?.connected).toBe(true);
  // Atom pack removed/disabled → its type is no longer in the registry.
  await h.service.setRegistry(new Map());
  expect(h.service.statusSnapshot()[0]?.connected).toBe(false);
});

test('channel: rate-limited user receives a throttle reply, no session is created', async () => {
  // rateLimitPerMin=0 → bucket starts at 0 tokens, every message is immediately throttled.
  const h = await makeHarness(
    channelConfig({ rateLimitPerMin: 0, allowlist: { allowAllUsers: true, allowedUsers: [] } })
  );
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', text: 'hi' }));
  await h.flush();
  expect(h.creates.length).toBe(0);
  // The throttle reply is sent via the adapter (not a session reply).
  expect(h.sends.some((s) => s.content.includes('quickly'))).toBe(true);
});

test('channel: per-user granularity creates separate sessions for different users in the same chat', async () => {
  const h = await makeHarness(
    channelConfig({ allowlist: { allowAllUsers: true, allowedUsers: [] }, mapping: { granularity: 'per-user' } })
  );
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'alice', text: 'hello' }));
  await h.flush();
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'bob', text: 'hello' }));
  await h.flush();
  // Same chatId, different userId → different conversation keys → two sessions.
  expect(h.creates.length).toBe(2);
});

test('channel: per-conversation granularity shares one session across users in the same chat', async () => {
  const h = await makeHarness(
    channelConfig({
      allowlist: { allowAllUsers: true, allowedUsers: [] },
      mapping: { granularity: 'per-conversation' }
    })
  );
  h.ctx.onMessage(inbound({ chatId: 'group', userId: 'alice', text: 'a' }));
  await h.flush();
  h.ctx.onMessage(inbound({ chatId: 'group', userId: 'bob', text: 'b' }));
  await h.flush();
  // Default per-conversation: same chatId → same key → same session.
  expect(h.creates.length).toBe(1);
});

// ---------- outbound mirror ----------

/** Build a minimal ChannelService harness whose adapter declares outboundMirror. Returns the
 *  live bus so tests can publish events as if they came from the web UI. */
async function makeMirrorHarness(mirror: boolean): Promise<{
  sends: { chatId: string; content: string }[];
  bus: EventBus;
  sessionId: () => SessionId;
  flush(): Promise<void>;
}> {
  const sends: { chatId: string; content: string }[] = [];
  const bus = new EventBus();
  let capturedCtx: ChannelContext | undefined;
  let lastSessionId: SessionId | undefined;

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
      outboundMirror: mirror
    },
    async connect() {},
    async disconnect() {},
    async send(chatId, content) {
      sends.push({ chatId, content });
      return { ref: String(sends.length), chatId };
    }
  };

  const store = createStore();
  const cfg: MonadConfig = {
    ...createDefaultConfig('prn_OWNER', 'owner'),
    channels: [channelConfig({ allowlist: { allowAllUsers: true, allowedUsers: [] } })]
  };
  const service = new ChannelService(
    {
      session: {
        createForPrincipal: async ({ title: _title, principalId: _principalId }) => ({ sessionId: newId('ses') }),
        sendInline: async ({ sessionId, text }, sink) => {
          lastSessionId = sessionId as SessionId;
          sink(messageEvent(`reply: ${text}`));
        },
        reset: async () => ({ clearedCount: 0 })
      },
      store,
      registry: new Map([
        [
          'telegram',
          (c: ChannelContext) => {
            capturedCtx = c;
            return adapter;
          }
        ]
      ]),
      log: { info: () => {}, warn: () => {}, error: () => {} },
      bus,
      t
    },
    cfg,
    EMPTY_AUTH
  );

  await service.start();
  if (!capturedCtx) throw new Error('adapter was not constructed');
  const ctx = capturedCtx;

  // Warm up: a Telegram inbound creates the session and registers the mirror subscription.
  ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', text: 'hello' }));
  await new Promise((r) => setTimeout(r, 20));

  return {
    sends,
    bus,
    // biome-ignore lint/style/noNonNullAssertion: always set before this is called (warm-up above)
    sessionId: () => lastSessionId!,
    flush: () => new Promise((r) => setTimeout(r, 20))
  };
}

function makeAgentEvent(sessionId: SessionId, type: Event['type'], payload: Record<string, unknown>): Event {
  return { id: newId('evt'), sessionId, type, actorAgentId: null, payload, at: '' };
}

test('mirror: web-UI agent reply is forwarded to the adapter when outboundMirror is true', async () => {
  const h = await makeMirrorHarness(true);
  const sid = h.sessionId();
  const countBefore = h.sends.length;

  // Simulate a web-UI turn: user message resets state, then agent replies.
  h.bus.publish(makeAgentEvent(sid, 'user.message', { messageId: newId('msg'), text: 'web hi' }));
  h.bus.publish(makeAgentEvent(sid, 'agent.message', { messageId: newId('msg'), text: 'web reply' }));
  await h.flush();

  expect(h.sends.length).toBeGreaterThan(countBefore);
  expect(h.sends.at(-1)?.content).toBe('web reply');
});

test('mirror: no forwarding when outboundMirror is false', async () => {
  const h = await makeMirrorHarness(false);
  const sid = h.sessionId();
  const countBefore = h.sends.length;

  h.bus.publish(makeAgentEvent(sid, 'user.message', { messageId: newId('msg'), text: 'web hi' }));
  h.bus.publish(makeAgentEvent(sid, 'agent.message', { messageId: newId('msg'), text: 'web reply' }));
  await h.flush();

  expect(h.sends.length).toBe(countBefore); // adapter.send never called by the mirror
});

test('mirror: Telegram inbound dispatch is not double-sent (activeDispatches guard)', async () => {
  // The real sendInline publishes events to the bus AND calls sink. If the mirror subscription
  // also ran during a Telegram inbound, adapter.send would be called twice for the same reply.
  const sends: { chatId: string; content: string }[] = [];
  const bus = new EventBus();
  let capturedCtx: ChannelContext | undefined;

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
      outboundMirror: true
    },
    async connect() {},
    async disconnect() {},
    async send(chatId, content) {
      sends.push({ chatId, content });
      return { ref: String(sends.length), chatId };
    }
  };

  const cfg: MonadConfig = {
    ...createDefaultConfig('prn_OWNER', 'owner'),
    channels: [channelConfig({ allowlist: { allowAllUsers: true, allowedUsers: [] } })]
  };
  const service = new ChannelService(
    {
      session: {
        createForPrincipal: async () => ({ sessionId: newId('ses') }),
        // Simulate real behavior: publish to bus AND call the direct sink.
        sendInline: async ({ sessionId, text }, sink) => {
          const evt = messageEvent(`reply: ${text}`);
          const withSid = { ...evt, sessionId: sessionId as SessionId };
          bus.publish(withSid);
          sink(withSid);
        },
        reset: async () => ({ clearedCount: 0 })
      },
      store: createStore(),
      registry: new Map([
        [
          'telegram',
          (c: ChannelContext) => {
            capturedCtx = c;
            return adapter;
          }
        ]
      ]),
      log: { info: () => {}, warn: () => {}, error: () => {} },
      bus,
      t
    },
    cfg,
    EMPTY_AUTH
  );
  await service.start();
  if (!capturedCtx) throw new Error('no ctx');

  capturedCtx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', text: 'hello' }));
  await new Promise((r) => setTimeout(r, 20));

  // Even though the bus fired the event, activeDispatches prevented the mirror from double-sending.
  expect(sends.filter((s) => s.content === 'reply: hello').length).toBe(1);
});

// ---------- access policy: allowlist / open / disabled / pairing ----------

test('access: allowlist policy rejects an unlisted user (no session, no reply)', async () => {
  const h = await makeHarness(channelConfig({ allowlist: { allowAllUsers: false, allowedUsers: ['u1'] } }));
  h.ctx.onMessage(inbound({ chatId: 'c', userId: 'stranger', text: 'hi' }));
  await h.flush();
  expect(h.creates.length).toBe(0);
  expect(h.sends.length).toBe(0);
});

test('access: open policy lets any user through', async () => {
  const h = await makeHarness(channelConfig({ allowlist: { policy: 'open', allowAllUsers: false, allowedUsers: [] } }));
  h.ctx.onMessage(inbound({ chatId: 'c', userId: 'anyone', text: 'hi' }));
  await h.flush();
  expect(h.creates.length).toBe(1);
});

test('access: disabled policy drops everyone, even a listed user', async () => {
  const h = await makeHarness(
    channelConfig({ allowlist: { policy: 'disabled', allowAllUsers: false, allowedUsers: ['u1'] } })
  );
  h.ctx.onMessage(inbound({ chatId: 'c', userId: 'u1', text: 'hi' }));
  await h.flush();
  expect(h.creates.length).toBe(0);
});

test('access: legacy allowAllUsers still behaves as open', async () => {
  const h = await makeHarness(channelConfig({ allowlist: { allowAllUsers: true, allowedUsers: [] } }));
  h.ctx.onMessage(inbound({ chatId: 'c', userId: 'anyone', text: 'hi' }));
  await h.flush();
  expect(h.creates.length).toBe(1);
});

// ---------- pairing flow ----------

test('pairing: an unknown DM sender gets a one-time code and no session is created', async () => {
  const h = await makeHarness(
    channelConfig({ allowlist: { policy: 'pairing', allowAllUsers: false, allowedUsers: [] } })
  );
  h.ctx.onMessage(inbound({ chatId: 'c', userId: 'newcomer', text: 'hi', chatType: 'dm' }));
  await h.flush();
  expect(h.creates.length).toBe(0);
  // The reply carries the issued code.
  const reply = h.sends.at(-1)?.content ?? '';
  expect(reply).toContain('🔑');
  const pending = h.service.listPendingPairings('chn_TESTCHANNEL');
  expect(pending.length).toBe(1);
  const issued = pending[0];
  if (!issued) throw new Error('expected a pending pairing');
  expect(issued.userId).toBe('newcomer');
  expect(reply).toContain(issued.code);
});

test('pairing: consuming a valid code returns the userId and removes the request', async () => {
  const h = await makeHarness(
    channelConfig({ allowlist: { policy: 'pairing', allowAllUsers: false, allowedUsers: [] } })
  );
  h.ctx.onMessage(inbound({ chatId: 'c', userId: 'newcomer', text: 'hi', chatType: 'dm' }));
  await h.flush();
  const pending = h.service.listPendingPairings('chn_TESTCHANNEL')[0];
  if (!pending) throw new Error('expected a pending pairing');
  const { code } = pending;
  expect(h.service.consumePairing('chn_TESTCHANNEL', code.toLowerCase())).toBe('newcomer'); // case-insensitive
  expect(h.service.consumePairing('chn_TESTCHANNEL', code)).toBe(null); // consumed
  expect(h.service.listPendingPairings('chn_TESTCHANNEL').length).toBe(0);
});

test('pairing: a repeat message from the same user reuses the live code (no spam)', async () => {
  const h = await makeHarness(
    channelConfig({ allowlist: { policy: 'pairing', allowAllUsers: false, allowedUsers: [] } })
  );
  h.ctx.onMessage(inbound({ chatId: 'c', userId: 'newcomer', text: 'one', chatType: 'dm' }));
  h.ctx.onMessage(inbound({ chatId: 'c', userId: 'newcomer', text: 'two', chatType: 'dm' }));
  await h.flush();
  expect(h.service.listPendingPairings('chn_TESTCHANNEL').length).toBe(1);
});

test('pairing: never issues a code in a group (treated as deny)', async () => {
  const h = await makeHarness(
    channelConfig({ allowlist: { policy: 'pairing', allowAllUsers: false, allowedUsers: [] } })
  );
  h.ctx.onMessage(inbound({ chatId: 'c', userId: 'newcomer', text: 'hi', chatType: 'group', mentionedSelf: true }));
  await h.flush();
  expect(h.service.listPendingPairings('chn_TESTCHANNEL').length).toBe(0);
  expect(h.creates.length).toBe(0);
});

// ---------- group require-mention gate ----------

test('group gate: an unaddressed group message is dropped when requireMention is on', async () => {
  const h = await makeHarness(channelConfig({ allowlist: { policy: 'open', allowAllUsers: false, allowedUsers: [] } }));
  h.ctx.onMessage(inbound({ chatId: 'g', userId: 'u', text: 'chatter', chatType: 'group' }));
  await h.flush();
  expect(h.creates.length).toBe(0);
});

test('group gate: a mention or reply gets through', async () => {
  const h = await makeHarness(channelConfig({ allowlist: { policy: 'open', allowAllUsers: false, allowedUsers: [] } }));
  h.ctx.onMessage(inbound({ chatId: 'g', userId: 'u', text: '@bot hi', chatType: 'group', mentionedSelf: true }));
  await h.flush();
  expect(h.creates.length).toBe(1);
});

test('group gate: a slash command is always addressed', async () => {
  const h = await makeHarness(channelConfig({ allowlist: { policy: 'open', allowAllUsers: false, allowedUsers: [] } }));
  h.ctx.onMessage(
    inbound({ chatId: 'g', userId: 'u', text: '/new', kind: 'command', command: 'new', chatType: 'group' })
  );
  await h.flush();
  // /new creates a session via the command path.
  expect(h.creates.length).toBeGreaterThanOrEqual(1);
});

test('group gate: requireMention=false answers every group message', async () => {
  const h = await makeHarness(
    channelConfig({
      allowlist: { policy: 'open', allowAllUsers: false, allowedUsers: [] },
      groupPolicy: { requireMention: false }
    })
  );
  h.ctx.onMessage(inbound({ chatId: 'g', userId: 'u', text: 'chatter', chatType: 'group' }));
  await h.flush();
  expect(h.creates.length).toBe(1);
});

test('group gate: DMs are always answered regardless of mention', async () => {
  const h = await makeHarness(channelConfig({ allowlist: { policy: 'open', allowAllUsers: false, allowedUsers: [] } }));
  h.ctx.onMessage(inbound({ chatId: 'c', userId: 'u', text: 'hi', chatType: 'dm' }));
  await h.flush();
  expect(h.creates.length).toBe(1);
});

test('group gate: without moderator, configured agent channels require an agent mention', async () => {
  const coder = testAgent('agt_CODER', 'Coder');
  const h = await makeHarness(
    channelConfig({
      allowlist: { policy: 'open', allowAllUsers: false, allowedUsers: [] },
      groupPolicy: { requireMention: false }
    }),
    testCommandBundle(),
    [coder]
  );
  h.ctx.onMessage(inbound({ chatId: 'g', userId: 'u', text: 'plain chatter', chatType: 'group' }));
  await h.flush();
  expect(h.creates).toHaveLength(0);

  h.ctx.onMessage(inbound({ chatId: 'g', userId: 'u', text: '@coder please inspect this', chatType: 'group' }));
  await h.flush();
  expect(h.creates).toHaveLength(1);
  expect(h.creates[0]?.agentId).toBe(coder.id);
});

test('moderator gate: an unaddressed group message routes to the moderator', async () => {
  const moderator = testAgent('agt_MODERATOR', 'Moderator');
  const coder = testAgent('agt_CODER', 'Coder');
  const h = await makeHarness(
    channelConfig({
      allowlist: { policy: 'open', allowAllUsers: false, allowedUsers: [] },
      groupPolicy: { requireMention: true, moderatorAgentId: moderator.id }
    }),
    testCommandBundle(),
    [moderator, coder]
  );
  h.ctx.onMessage(inbound({ chatId: 'g', userId: 'u', text: 'please coordinate this', chatType: 'group' }));
  await h.flush();
  expect(h.creates).toHaveLength(1);
  expect(h.creates[0]?.agentId).toBe(moderator.id);
  expect(h.sends.map((s) => s.content)).toEqual(['reply: please coordinate this']);
});

test('moderator gate: one agent mention runs that agent then returns the result to moderator', async () => {
  const moderator = testAgent('agt_MODERATOR', 'Moderator');
  const coder = testAgent('agt_CODER', 'Code Agent');
  const h = await makeHarness(
    channelConfig({
      allowlist: { policy: 'open', allowAllUsers: false, allowedUsers: [] },
      groupPolicy: { requireMention: true, moderatorAgentId: moderator.id }
    }),
    testCommandBundle(),
    [moderator, coder]
  );
  h.ctx.onMessage(inbound({ chatId: 'g', userId: 'u', text: '@code-agent fix login', chatType: 'group' }));
  await h.flush();
  expect(h.creates.map((c) => c.agentId)).toEqual([coder.id, moderator.id]);
  expect(h.sends[0]?.content).toBe('reply: @code-agent fix login');
  expect(h.sends[1]?.content).toContain('Agent Code Agent returned a channel-visible result.');
  expect(h.sends[1]?.content).toContain('Agent result: reply: @code-agent fix login');
});

test('moderator gate: multiple agent mentions route directly to moderator', async () => {
  const moderator = testAgent('agt_MODERATOR', 'Moderator');
  const coder = testAgent('agt_CODER', 'Coder');
  const reviewer = testAgent('agt_REVIEWER', 'Reviewer');
  const h = await makeHarness(
    channelConfig({
      allowlist: { policy: 'open', allowAllUsers: false, allowedUsers: [] },
      groupPolicy: { requireMention: true, moderatorAgentId: moderator.id }
    }),
    testCommandBundle(),
    [moderator, coder, reviewer]
  );
  h.ctx.onMessage(inbound({ chatId: 'g', userId: 'u', text: '@coder @reviewer split this', chatType: 'group' }));
  await h.flush();
  expect(h.creates).toHaveLength(1);
  expect(h.creates[0]?.agentId).toBe(moderator.id);
  expect(h.sends.map((s) => s.content)).toEqual(['reply: @coder @reviewer split this']);
});

test('moderator next: fanout tasks display immediately, then all results return to moderator', async () => {
  const moderator = testAgent('agt_MODERATOR', 'Moderator');
  const coder = testAgent('agt_CODER', 'Coder');
  const reviewer = testAgent('agt_REVIEWER', 'Reviewer');
  const h = await makeHarness(
    channelConfig({
      allowlist: { policy: 'open', allowAllUsers: false, allowedUsers: [] },
      groupPolicy: { requireMention: true, moderatorAgentId: moderator.id }
    }),
    testCommandBundle(),
    [moderator, coder, reviewer],
    async ({ text }, sink) => {
      if (text === 'coordinate release') {
        sink(
          messageEvent(
            JSON.stringify({
              display: { content: 'starting tasks' },
              next: [
                { agentId: coder.id, title: 'code', prompt: 'inspect code' },
                { agentId: reviewer.id, title: 'review', prompt: 'review risk' }
              ]
            })
          )
        );
        return;
      }
      if (text.includes('Title: code')) {
        sink(messageEvent(JSON.stringify({ display: { content: 'code done' }, next: [] })));
        return;
      }
      if (text.includes('Title: review')) {
        sink(messageEvent(JSON.stringify({ display: { content: 'review done' }, next: [] })));
        return;
      }
      if (text.startsWith('A batch of moderator-assigned tasks returned')) {
        expect(text).toContain('Agent result: code done');
        expect(text).toContain('Agent result: review done');
        sink(messageEvent(JSON.stringify({ display: { content: 'all done' }, next: [] })));
      }
    }
  );

  h.ctx.onMessage(inbound({ chatId: 'g', userId: 'u', text: 'coordinate release', chatType: 'group' }));
  await h.flush();

  expect(h.creates.map((c) => c.agentId)).toEqual([moderator.id, coder.id, reviewer.id]);
  expect(h.sends.map((s) => s.content)).toEqual(['starting tasks', 'code done', 'review done', 'all done']);
});

test('moderator next: timed-out task does not block continuation', async () => {
  const moderator = testAgent('agt_MODERATOR', 'Moderator');
  const coder = testAgent('agt_CODER', 'Coder');
  const reviewer = testAgent('agt_REVIEWER', 'Reviewer');
  const h = await makeHarness(
    channelConfig({
      allowlist: { policy: 'open', allowAllUsers: false, allowedUsers: [] },
      groupPolicy: { requireMention: true, moderatorAgentId: moderator.id }
    }),
    testCommandBundle(),
    [moderator, coder, reviewer],
    async ({ text }, sink) => {
      if (text === 'coordinate with timeout') {
        sink(
          messageEvent(
            JSON.stringify({
              display: { content: 'starting timeout tasks' },
              next: [
                { agentId: coder.id, title: 'code', prompt: 'inspect code' },
                { agentId: reviewer.id, title: 'review', prompt: 'hang forever' }
              ]
            })
          )
        );
        return;
      }
      if (text.includes('Title: code')) {
        sink(messageEvent(JSON.stringify({ display: { content: 'code done before timeout' }, next: [] })));
        return;
      }
      if (text.includes('Title: review')) {
        await new Promise(() => {});
        return;
      }
      if (text.startsWith('A batch of moderator-assigned tasks returned')) {
        expect(text).toContain('Agent result: code done before timeout');
        expect(text).toContain('Agent result: (timed out waiting for agent result)');
        sink(messageEvent(JSON.stringify({ display: { content: 'continued after timeout' }, next: [] })));
      }
    },
    10
  );

  h.ctx.onMessage(inbound({ chatId: 'g', userId: 'u', text: 'coordinate with timeout', chatType: 'group' }));
  await new Promise((r) => setTimeout(r, 60));

  expect(h.sends.map((s) => s.content)).toEqual([
    'starting timeout tasks',
    'code done before timeout',
    'continued after timeout'
  ]);
});

test('moderator next: invalid and self targets are not executed', async () => {
  const moderator = testAgent('agt_MODERATOR', 'Moderator');
  const coder = testAgent('agt_CODER', 'Coder');
  const h = await makeHarness(
    channelConfig({
      allowlist: { policy: 'open', allowAllUsers: false, allowedUsers: [] },
      groupPolicy: { requireMention: true, moderatorAgentId: moderator.id }
    }),
    testCommandBundle(),
    [moderator, coder],
    async ({ text }, sink) => {
      if (text === 'filter targets') {
        sink(
          messageEvent(
            JSON.stringify({
              display: { content: 'filtering' },
              next: [
                { agentId: moderator.id, title: 'self', prompt: 'do not run' },
                { agentId: 'agt_MISSING', title: 'missing', prompt: 'do not run' },
                { agentId: coder.id, title: 'code', prompt: 'run' }
              ]
            })
          )
        );
        return;
      }
      if (text.includes('Title: code')) {
        sink(messageEvent(JSON.stringify({ display: { content: 'code ran' }, next: [] })));
        return;
      }
      if (text.startsWith('A batch of moderator-assigned tasks returned')) {
        sink(messageEvent(JSON.stringify({ display: { content: 'filtered done' }, next: [] })));
      }
    }
  );

  h.ctx.onMessage(inbound({ chatId: 'g', userId: 'u', text: 'filter targets', chatType: 'group' }));
  await h.flush();

  expect(h.creates.map((c) => c.agentId)).toEqual([moderator.id, coder.id]);
  expect(h.sends.map((s) => s.content)).toEqual(['filtering', 'code ran', 'filtered done']);
  expect(h.logs.some((l) => l.message.includes('cannot be the moderator itself'))).toBe(true);
  expect(h.logs.some((l) => l.message.includes('agt_MISSING is not configured'))).toBe(true);
});

test('moderator recovery: open round is summarized to moderator on restart', async () => {
  const moderator = testAgent('agt_MODERATOR', 'Moderator');
  const coder = testAgent('agt_CODER', 'Coder');
  const original = inbound({ chatId: 'g', userId: 'u', text: 'recover release', chatType: 'group' });
  const h = await makeHarness(
    channelConfig({
      allowlist: { policy: 'open', allowAllUsers: false, allowedUsers: [] },
      groupPolicy: { requireMention: true, moderatorAgentId: moderator.id }
    }),
    testCommandBundle(),
    [moderator, coder],
    async ({ text }, sink) => {
      if (text.startsWith('A previously open moderator task batch was recovered')) {
        expect(text).toContain('Agent result: code result before restart');
        expect(text).toContain('daemon restarted before agent result was observed');
        sink(messageEvent(JSON.stringify({ display: { content: 'recovered summary handled' }, next: [] })));
      }
    },
    undefined,
    (store) => {
      store.createChannelModeratorRound({
        id: 'rnd_recover',
        channelId: 'chn_TESTCHANNEL',
        moderatorKey: 'chn_TESTCHANNEL|g|a:agt_MODERATOR',
        moderatorAgentId: moderator.id,
        originalInbound: original,
        depth: 0,
        deadlineAt: '2026-06-25T00:02:00.000Z',
        tasks: [
          {
            index: 0,
            agentId: coder.id,
            agentName: coder.name,
            title: 'code',
            task: { agentId: coder.id, title: 'code', prompt: 'inspect' }
          },
          {
            index: 1,
            agentId: 'agt_MISSING',
            agentName: 'Missing',
            title: 'missing',
            task: { agentId: 'agt_MISSING', title: 'missing', prompt: 'lost' }
          }
        ]
      });
      store.updateChannelModeratorRoundResults('rnd_recover', [
        { index: 0, agentId: coder.id, agentName: coder.name, title: 'code', result: 'code result before restart' }
      ]);
    }
  );
  await h.flush();

  expect(h.sends.map((s) => s.content)).toEqual(['recovered summary handled']);
  expect(h.store.listOpenChannelModeratorRounds('chn_TESTCHANNEL')).toEqual([]);
});

// ---------- agent hint ----------

test('agentHint: rides on the session origin ext with the structured response hint', async () => {
  const h = await makeHarness(channelConfig({ agentHint: 'IM surface — keep replies short.' }));
  h.ctx.onMessage(inbound({ chatId: 'c', userId: 'u1', text: 'hi' }));
  await h.flush();
  const origin = h.creates[0]?.origin as { ext?: { agentHint?: string } } | undefined;
  expect(origin?.ext?.agentHint).toContain('IM surface — keep replies short.');
  expect(origin?.ext?.agentHint).toContain('return exactly one JSON object');
});

test('agentHint: absent ⇒ only the structured response hint rides on the origin', async () => {
  const h = await makeHarness(channelConfig());
  h.ctx.onMessage(inbound({ chatId: 'c', userId: 'u1', text: 'hi' }));
  await h.flush();
  const origin = h.creates[0]?.origin as { ext?: { agentHint?: string } } | undefined;
  expect(origin?.ext?.agentHint).toContain('return exactly one JSON object');
});
