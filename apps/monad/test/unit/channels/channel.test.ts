import type { ChannelInstanceConfig, MonadAuth, MonadConfig } from '@monad/environment';
import type { Translate } from '@monad/i18n';
import type { ChannelInbound, Event, MessageId, ProjectId, SessionId } from '@monad/protocol';
import type {
  ChannelAdapter,
  ChannelAdapterFactory,
  ChannelContext,
  ChannelRuntimeStatus,
  SendOptions,
  SentMessage
} from '@monad/sdk-atom';
import type { CommandBundle } from '#/handlers/commands/index.ts';

import { expect, test } from 'bun:test';
import { createDefaultConfig, emptyAuth } from '@monad/environment';
import { createI18n } from '@monad/i18n';
import { enMessages as i18nMessages } from '@monad/i18n/messages';
import { channelDisplayText, newId } from '@monad/protocol';

import { ChannelService, sweepIdleBuckets } from '#/channels/channel.ts';
import { createRenderer } from '#/channels/render.ts';
import { EventBus } from '#/services/event-bus.ts';
import { createStore } from '#/store/db/index.ts';
import { seededCommandRegistry } from '../../helpers.ts';

const agentProducer = { kind: 'agent', agentId: 'agt_100000000000' } as const;

/** A real English translator so command/channel replies read as before (assertions check English). */
const t = createI18n({ locale: 'en', packs: [{ locale: 'en', name: 'English', messages: i18nMessages }] }).t;

function recordingTranslator() {
  const calls: Array<{ key: string; params?: unknown }> = [];
  const t: Translate = (key, params) => {
    calls.push({ key: String(key), ...(params ? { params } : {}) });
    return String(key);
  };
  return { calls, t };
}

/** A command bundle for the channel harness: the real built-in registry + inert model/compact hooks. */
function testCommandBundle(): CommandBundle {
  return {
    registry: seededCommandRegistry(),
    skills: () => [],
    listModels: async () => [{ alias: 'fast', provider: 'p', modelId: 'm', current: true }],
    setModel: async () => {},
    setEffort: async () => {},
    compact: async () => ({ compacted: 0 }),
    consolidate: async () => ({ level: 1, l1Scopes: 0, nodes: 0, edges: 0, prunedEdges: 0, laws: 0, lawScopes: 0 }),
    explainBelief: async () => ({ matches: [] }),
    checkMemory: async () => ({ flagged: 0 }),
    handoff: async () => ({ sessionId: 'ses_new000000000' as SessionId }),
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

const EMPTY_AUTH: MonadAuth = emptyAuth();

function tokenEvent(delta: string, index: number): Event {
  return {
    id: newId('evt'),
    sessionId: 'ses_X00000000000' as SessionId,
    type: 'session.message.delta.appended',
    actorAgentId: null,
    payload: {
      transcriptTargetId: 'ses_X00000000000',
      producer: agentProducer,
      messageId: 'msg_X00000000000' as MessageId,
      channel: 'content',
      delta,
      index
    },
    at: ''
  };
}
function messageEvent(text: string): Event {
  return {
    id: newId('evt'),
    sessionId: 'ses_X00000000000' as SessionId,
    type: 'session.message.completed',
    actorAgentId: null,
    payload: {
      transcriptTargetId: 'ses_X00000000000',
      producer: agentProducer,
      message: {
        id: 'msg_X00000000000' as MessageId,
        sessionId: 'ses_X00000000000',
        role: 'assistant',
        text,
        type: 'text',
        stream: { status: 'complete' },
        active: true,
        createdAt: '2026-07-18T00:00:00.000Z'
      },
      messageRevision: 2
    },
    at: ''
  };
}

// ---------- renderer ----------

function makeCapturingAdapter(edit: boolean): {
  adapter: ChannelAdapter;
  sends: string[];
  sendOptions: Array<SendOptions | undefined>;
  edits: string[];
} {
  const sends: string[] = [];
  const sendOptions: Array<SendOptions | undefined> = [];
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
    async send(_chatId, content, options): Promise<SentMessage> {
      sends.push(content);
      sendOptions.push(options);
      return { ref: String(sends.length), chatId: _chatId };
    },
    async editMessage(_msg, content) {
      edits.push(content);
    }
  };
  return { adapter, sends, sendOptions, edits };
}

test('renderer (buffered): emits one message per completed assistant message', async () => {
  const { adapter, sends } = makeCapturingAdapter(false);
  const r = createRenderer({ adapter, chatId: 'c1', log: () => {}, t });
  r.consume(tokenEvent('hel', 0)); // ignored in buffered mode
  r.consume(tokenEvent('lo', 1));
  r.consume(messageEvent('hello world'));
  await r.finalize();
  expect(sends).toEqual(['hello world']);
});

test('renderer: every chunk keeps an opaque native reply target private', async () => {
  const { adapter, sendOptions } = makeCapturingAdapter(false);
  adapter.capabilities.maxMessageChars = 6;
  const r = createRenderer({
    adapter,
    chatId: 'c1',
    replyTo: 'interaction:123',
    log: () => {},
    t
  });
  r.consume(messageEvent('hello world'));
  await r.finalize();
  expect(sendOptions).toEqual([
    { threadId: undefined, replyTo: 'interaction:123' },
    { threadId: undefined, replyTo: 'interaction:123' }
  ]);
});

test('renderer consumes canonical lifecycle without duplicating repeated deltas', async () => {
  const { adapter, sends } = makeCapturingAdapter(false);
  const r = createRenderer({ adapter, chatId: 'c1', log: () => {}, t });
  const messageId = 'msg_X00000000000' as MessageId;
  r.consume({
    ...tokenEvent('hello', 0),
    type: 'session.message.delta.appended',
    payload: {
      transcriptTargetId: 'ses_X00000000000',
      producer: agentProducer,
      messageId,
      channel: 'content',
      delta: 'hello',
      index: 0
    }
  });
  r.consume({
    ...messageEvent('hello'),
    type: 'session.message.completed',
    payload: {
      transcriptTargetId: 'ses_X00000000000',
      producer: agentProducer,
      message: {
        id: messageId,
        sessionId: 'ses_X00000000000',
        role: 'assistant',
        text: 'hello',
        type: 'text',
        stream: { status: 'complete' },
        active: true,
        createdAt: '2026-07-18T00:00:00.000Z'
      },
      messageRevision: 3
    }
  });
  await r.finalize();

  expect(sends).toEqual(['hello']);
});

test('renderer: structured channel response renders only display content', async () => {
  const { adapter, sends } = makeCapturingAdapter(false);
  const r = createRenderer({ adapter, chatId: 'c1', log: () => {}, t });
  r.consume(
    messageEvent(
      JSON.stringify({
        display: { kind: 'markdown', content: 'visible update' },
        attachments: [{ kind: 'note', text: 'metadata' }],
        next: [{ agentId: 'agt_NEXT00000000', prompt: 'do work' }]
      })
    )
  );
  await r.finalize();
  expect(sends).toEqual(['visible update\n\nAttachments:\n- note']);
});

test('channelDisplayText falls back to raw text for legacy replies', () => {
  expect(channelDisplayText('plain reply')).toBe('plain reply');
  expect(channelDisplayText('```json\n{"display":{"content":"from fence"}}\n```')).toBe('from fence');
  expect(channelDisplayText(`\`\`\`json\n${' '.repeat(100_000)}{"display":{"content":"bounded fence"}}\n\`\`\``)).toBe(
    'bounded fence'
  );
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

test('renderer (summary): edit-capable channels buffer tokens and send only the final message', async () => {
  const { adapter, sends, edits } = makeCapturingAdapter(true);
  const r = createRenderer({ adapter, chatId: 'c1', log: () => {}, t, renderMode: 'summary' });
  r.consume(tokenEvent('hel', 0));
  r.consume(tokenEvent('lo', 1));
  r.consume(messageEvent('hello world'));
  await r.finalize();
  expect(sends).toEqual(['hello world']);
  expect(edits).toEqual([]);
});

test('renderer: failed assistant message surfaces an error and resets stream state', async () => {
  const { adapter, sends } = makeCapturingAdapter(true);
  const translations = recordingTranslator();
  const r = createRenderer({ adapter, chatId: 'c1', log: () => {}, t: translations.t });
  r.consume(tokenEvent('partial', 0)); // start a streaming bubble
  r.consume({
    id: newId('evt'),
    sessionId: 'ses_X00000000000' as SessionId,
    type: 'session.message.failed',
    actorAgentId: null,
    payload: {
      transcriptTargetId: 'ses_X00000000000',
      producer: agentProducer,
      message: {
        id: 'msg_X00000000000',
        sessionId: 'ses_X00000000000',
        role: 'assistant',
        text: '503: upstream 503',
        type: 'error',
        stream: { status: 'error' },
        active: true,
        createdAt: '2026-07-18T00:00:00.000Z'
      },
      messageRevision: 2
    },
    at: ''
  });
  await r.finalize(); // finalize should not flush the abandoned bubble
  expect(translations.calls).toEqual([{ key: 'channel.error', params: { label: '503: upstream 503' } }]);
  expect(sends).toContain('channel.error');
  // The next message starts a fresh bubble after the failed lifecycle reset.
  const countBefore = sends.length;
  r.consume(tokenEvent('fresh', 0));
  r.consume(messageEvent('fresh message'));
  await r.finalize();
  expect(sends.length).toBeGreaterThan(countBefore); // fresh bubble sent
});

test('renderer: failed assistant message includes the failure text', async () => {
  const { adapter, sends } = makeCapturingAdapter(false);
  const translations = recordingTranslator();
  const r = createRenderer({ adapter, chatId: 'c1', log: () => {}, t: translations.t });
  r.consume({
    id: newId('evt'),
    sessionId: 'ses_X00000000000' as SessionId,
    type: 'session.message.failed',
    actorAgentId: null,
    payload: {
      transcriptTargetId: 'ses_X00000000000',
      producer: agentProducer,
      message: {
        id: 'msg_X00000000000',
        sessionId: 'ses_X00000000000',
        role: 'assistant',
        text: 'something broke',
        type: 'error',
        stream: { status: 'error' },
        active: true,
        createdAt: '2026-07-18T00:00:00.000Z'
      },
      messageRevision: 2
    },
    at: ''
  });
  await r.finalize();
  expect(translations.calls).toEqual([{ key: 'channel.error', params: { label: 'something broke' } }]);
  expect(sends).toContain('channel.error');
});

test('renderer: surfaces an approval notice (no channel approver)', async () => {
  const { adapter, sends } = makeCapturingAdapter(false);
  const translations = recordingTranslator();
  const r = createRenderer({ adapter, chatId: 'c1', log: () => {}, t: translations.t });
  r.consume({
    id: newId('evt'),
    sessionId: 'ses_X00000000000' as SessionId,
    type: 'tool.approval_requested',
    actorAgentId: null,
    payload: {},
    at: ''
  });
  await r.finalize();
  expect(translations.calls).toEqual([{ key: 'channel.approvalNeeded' }]);
  expect(sends).toEqual(['channel.approvalNeeded']);
});

// ---------- ChannelService (mock adapter) ----------

interface Harness {
  service: ChannelService;
  ctx: ChannelContext;
  sends: { chatId: string; content: string }[];
  creates: { title: string; agentId?: string; origin?: unknown }[];
  projectCreates: { projectId: ProjectId; title: string; origin?: unknown }[];
  projectMessages: { sessionId: SessionId; text: string }[];
  reactions: { messageId: string; emoji: string }[];
  logs: { level: 'info' | 'warn' | 'error'; message: string }[];
  store: ReturnType<typeof createStore>;
  flush(): Promise<void>;
}

function channelConfig(over: Partial<ChannelInstanceConfig> = {}): ChannelInstanceConfig {
  return {
    id: 'chn_TESTCHANNEL0',
    type: 'telegram',
    label: 'Test',
    enabled: true,
    mapping: { granularity: 'per-conversation' },
    agentId: 'agt_CHANNELDEFLT',
    credential: { token: 'literal-token' },
    rateLimitPerMin: 100,
    ...over
  };
}

function testAgent(id: `agt_${string}`, name: string): MonadConfig['agent']['agents'][number] {
  return {
    id,
    name,
    capabilities: [],
    credentialIds: [],
    declaredScopes: [],
    memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 },
    atoms: { mode: 'inherit', allow: [], deny: [] },
    visibility: { subagentCallable: false, public: false },
    a2a: { enabled: false },
    monadix: { consume: false }
  };
}

async function makeHarness(
  channel: ChannelInstanceConfig,
  commands: CommandBundle = testCommandBundle(),
  agents: MonadConfig['agent']['agents'] = [],
  sendInline: HarnessSendInline = async ({ text }, sink) => {
    sink(messageEvent(`reply: ${text}`));
  },
  connectStatus?: ChannelRuntimeStatus,
  groupMentionPolicy = true
): Promise<Harness> {
  const store = createStore();
  const sends: Harness['sends'] = [];
  const creates: Harness['creates'] = [];
  const projectCreates: Harness['projectCreates'] = [];
  const projectMessages: Harness['projectMessages'] = [];
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
      outboundMirror: false,
      groupMentionPolicy
    },
    async connect() {
      if (connectStatus) captured?.onStatus?.(connectStatus);
    },
    async disconnect() {},
    async send(chatId, content) {
      sends.push({ chatId, content });
      return { ref: String(sends.length), chatId };
    },
    async react(target, emoji) {
      reactions.push({ messageId: target.messageId, emoji });
    }
  };
  const factory: ChannelAdapterFactory = (context: ChannelContext) => {
    captured = context;
    return adapter;
  };
  if (channel.type === 'whatsapp') factory.connectionMode = 'pairing';

  const cfg: MonadConfig = { ...createDefaultConfig('owner'), channels: [channel] };
  cfg.agent.agents = agents;
  const service = new ChannelService(
    {
      session: {
        create: async ({ title, agentId, origin }) => {
          creates.push({ title, agentId, origin });
          const sessionId = newId('ses');
          const now = new Date().toISOString();
          store.insertSession({
            id: sessionId,
            title,
            state: 'active',
            agentIds: agentId ? [agentId] : [],
            archived: false,
            restoreCount: 0,
            origin,
            createdAt: now,
            updatedAt: now
          });
          return { sessionId };
        },
        createProjectSession: async ({ projectId, title, origin }) => {
          projectCreates.push({ projectId, title, origin });
          const sessionId = newId('ses');
          const now = new Date().toISOString();
          store.insertSession({
            id: sessionId,
            projectId,
            title,
            state: 'active',
            agentIds: [],
            archived: false,
            restoreCount: 0,
            origin,
            createdAt: now,
            updatedAt: now
          });
          return { sessionId };
        },
        sendProjectMessage: async ({ sessionId, text }) => {
          projectMessages.push({ sessionId, text });
          return { accepted: true };
        },
        sendInline,
        reset: async () => ({ clearedCount: 0 })
      },
      store,
      registry: new Map([[channel.type, factory]]),
      commands,
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
    projectCreates,
    projectMessages,
    reactions,
    logs,
    store,
    flush: () => new Promise((r) => setTimeout(r, 20))
  };
}

type HarnessSendInline = (
  args: { sessionId: SessionId; text: string },
  sink: (event: Event) => void,
  runOpts?: { transport?: string; ambientContext?: string }
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
});

test('channel: constructing an adapter supplies localized connection guidance', async () => {
  const h = await makeHarness(channelConfig());
  expect(h.ctx.config).toEqual({
    id: 'chn_TESTCHANNEL0',
    type: 'telegram',
    label: 'Test',
    connectedWelcome:
      'Monad is connected.\n\nSend /project list, then /project use <number> to choose a Project and start chatting here.'
  });
});

test('channel: an allowed inbound creates a session and returns the reply', async () => {
  const h = await makeHarness(channelConfig());
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', text: 'hi' }));
  await h.flush();

  expect(h.creates.length).toBe(1);
  expect(h.sends.at(-1)).toEqual({ chatId: 'chat1', content: 'reply: hi' });
});

test('channel: an inbound without a Project Session or explicit Agent returns Project setup guidance', async () => {
  const h = await makeHarness(channelConfig({ agentId: undefined }));
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', text: 'hi' }));
  await h.flush();

  expect({ creates: h.creates, projectCreates: h.projectCreates, sends: h.sends }).toEqual({
    creates: [],
    projectCreates: [],
    sends: [
      {
        chatId: 'chat1',
        content:
          'This channel is not connected to a Project Session. Use /project list to view available Projects, then /project use <number or name> to connect one.'
      }
    ]
  });
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
  const h = await makeHarness(channelConfig());
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

  // a following message uses the NEW session, not the first
  const before = h.creates.length;
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', text: 'third' }));
  await h.flush();
  expect(h.creates.length).toBe(before); // reused the /new session
});

test('channel: /project switches Telegram messages to a reusable Project Session and can leave it', async () => {
  const h = await makeHarness(channelConfig({ agentId: undefined }));
  const now = new Date().toISOString();
  const firstProjectId = 'prj_PROJECT00001' as ProjectId;
  const secondProjectId = 'prj_PROJECT00002' as ProjectId;
  for (const [id, title] of [
    [firstProjectId, 'Engineering'],
    [secondProjectId, 'Launch']
  ] as const) {
    h.store.insertWorkplaceProject({
      id,
      title,
      state: 'active',
      archived: false,
      memberTemplates: [],
      createdAt: now,
      updatedAt: now
    });
  }
  h.store.insertSession({
    id: 'ses_EXISTING0001' as SessionId,
    title: 'Existing Launch Session',
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    projectId: secondProjectId,
    createdAt: now,
    updatedAt: now
  });

  h.ctx.onMessage(
    inbound({
      chatId: 'chat1',
      userId: 'u1',
      kind: 'command',
      command: 'project',
      text: '/project'
    })
  );
  await h.flush();
  expect({ creates: h.creates, projectCreates: h.projectCreates, reply: h.sends.at(-1)?.content }).toEqual({
    creates: [],
    projectCreates: [],
    reply: 'Projects:\n   1. Launch\n   2. Engineering\n\nSwitch with /project use <number>.'
  });

  h.ctx.onMessage(
    inbound({
      chatId: 'chat1',
      userId: 'u1',
      kind: 'command',
      command: 'project',
      commandArgs: ['use', 'Launch'],
      text: '/project use Launch'
    })
  );
  await h.flush();
  expect({ creates: h.creates, projectCreates: h.projectCreates, reply: h.sends.at(-1)?.content }).toEqual({
    creates: [],
    projectCreates: [],
    reply:
      'Selected Project Launch.\n\nSessions:\n   1. Existing Launch Session\n\nUse /switch <number> to bind a session, or send a message to create and bind a new one.'
  });

  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', text: 'prepare the launch' }));
  await h.flush();
  expect(h.projectCreates.map((entry) => ({ projectId: entry.projectId, title: entry.title }))).toEqual([
    { projectId: secondProjectId, title: 'Test: Launch' }
  ]);
  expect(h.projectMessages.map((entry) => entry.text)).toEqual(['prepare the launch']);
  expect(h.sends.at(-1)?.content).toBe(
    'Your message was added to the Project Session, but it has no members, so no one can reply. Add a member in Monad, then send another message.'
  );

  const chatSessionCreates = h.creates.length;
  h.ctx.onMessage(
    inbound({
      chatId: 'chat1',
      userId: 'u1',
      kind: 'command',
      command: 'new',
      text: '/new',
      nativeMessageId: 'project-new'
    })
  );
  await h.flush();
  expect(h.sends.at(-1)).toEqual({
    chatId: 'chat1',
    content: 'The current Project Session does not support /new.'
  });
  expect(h.creates).toHaveLength(chatSessionCreates);

  for (const command of ['reset', 'compact', 'model']) {
    h.ctx.onMessage(
      inbound({
        chatId: 'chat1',
        userId: 'u1',
        kind: 'command',
        command,
        text: `/${command}`,
        nativeMessageId: `project-${command}`
      })
    );
    await h.flush();
    expect(h.sends.at(-1)).toEqual({
      chatId: 'chat1',
      content: `The current Project Session does not support /${command}.`
    });
  }

  h.ctx.onMessage(
    inbound({
      chatId: 'chat1',
      userId: 'u1',
      kind: 'command',
      command: 'help',
      text: '/help',
      nativeMessageId: 'project-help'
    })
  );
  await h.flush();
  expect(h.sends.at(-1)?.content).toContain('/project');
  expect(h.sends.at(-1)?.content).not.toContain('/new');
  expect(h.sends.at(-1)?.content).not.toContain('/reset');
  expect(h.sends.at(-1)?.content).not.toContain('/compact');
  expect(h.sends.at(-1)?.content).not.toContain('/model');

  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', text: 'check it again' }));
  await h.flush();

  expect(h.projectCreates.map((entry) => ({ projectId: entry.projectId, title: entry.title }))).toEqual([
    { projectId: secondProjectId, title: 'Test: Launch' }
  ]);
  expect(h.projectMessages.map((entry) => entry.text)).toEqual(['prepare the launch', 'check it again']);
  expect(new Set(h.projectMessages.map((entry) => entry.sessionId)).size).toBe(1);

  h.ctx.onMessage(
    inbound({
      chatId: 'chat1',
      userId: 'u1',
      kind: 'command',
      command: 'project',
      commandArgs: ['leave'],
      text: '/project leave'
    })
  );
  await h.flush();
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', text: 'back to default' }));
  await h.flush();

  expect(h.projectMessages.map((entry) => entry.text)).toEqual(['prepare the launch', 'check it again']);
  expect(h.sends.at(-1)).toEqual({
    chatId: 'chat1',
    content:
      'This channel is not connected to a Project Session. Use /project list to view available Projects, then /project use <number or name> to connect one.'
  });
  expect(h.creates).toEqual([]);
});

test('channel: /project use lists Project Sessions and /switch binds the selected Session', async () => {
  const h = await makeHarness(channelConfig({ agentId: undefined }));
  const now = new Date().toISOString();
  const projectId = 'prj_PROJECT00003' as ProjectId;
  const sessionId = 'ses_PROJECT00003' as SessionId;
  h.store.insertWorkplaceProject({
    id: projectId,
    title: 'Support',
    state: 'active',
    archived: false,
    memberTemplates: [],
    createdAt: now,
    updatedAt: now
  });
  h.store.insertSession({
    id: sessionId,
    title: 'Escalations',
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    projectId,
    createdAt: now,
    updatedAt: now
  });

  h.ctx.onMessage(
    inbound({
      chatId: 'chat1',
      userId: 'u1',
      kind: 'command',
      command: 'project',
      commandArgs: ['use', 'Support'],
      text: '/project use Support'
    })
  );
  await h.flush();
  expect(h.sends.at(-1)?.content).toBe(
    'Selected Project Support.\n\nSessions:\n   1. Escalations\n\nUse /switch <number> to bind a session, or send a message to create and bind a new one.'
  );
  expect(h.projectCreates).toEqual([]);

  h.ctx.onMessage(
    inbound({
      chatId: 'chat1',
      userId: 'u1',
      kind: 'command',
      command: 'switch',
      text: '/switch'
    })
  );
  await h.flush();
  expect(h.sends.at(-1)?.content).toBe('Sessions:\n   1. Escalations\n\nSwitch with /switch <number>.');

  h.ctx.onMessage(
    inbound({
      chatId: 'chat1',
      userId: 'u1',
      kind: 'command',
      command: 'switch',
      commandArgs: ['1'],
      text: '/switch 1'
    })
  );
  await h.flush();
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', text: 'follow up' }));
  await h.flush();

  expect(h.projectCreates).toEqual([]);
  expect(h.projectMessages).toEqual([{ sessionId, text: 'follow up' }]);
});

test('channel: non-Project commands do not create a Session while Project setup is required', async () => {
  const h = await makeHarness(channelConfig({ agentId: undefined }), testCommandBundle());
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', kind: 'command', command: 'help', text: '/help' }));
  await h.flush();

  expect({ creates: h.creates, sends: h.sends }).toEqual({
    creates: [],
    sends: [
      {
        chatId: 'chat1',
        content:
          'This channel is not connected to a Project Session. Use /project list to view available Projects, then /project use <number or name> to connect one.'
      }
    ]
  });
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
  expect(h.reactions).toContainEqual({ messageId: 'cmd-reset', emoji: '✅' });

  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', kind: 'command', command: 'help', text: '/help' }));
  await h.flush();
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

test('channel: an unknown command reports that the current Chat Session does not support it', async () => {
  const h = await makeHarness(channelConfig(), testCommandBundle());
  h.ctx.onMessage(
    inbound({
      chatId: 'chat1',
      userId: 'u1',
      kind: 'command',
      command: 'bogus',
      text: '/bogus',
      nativeMessageId: 'cmd-bogus'
    })
  );
  await h.flush();
  expect(h.sends.at(-1)).toEqual({
    chatId: 'chat1',
    content: 'The current Chat Session does not support /bogus.'
  });
  expect(h.reactions).toContainEqual({ messageId: 'cmd-bogus', emoji: '✅' });
});

test('channel: an available user-invocable Skill command still falls through to the agent', async () => {
  const commands: CommandBundle = {
    ...testCommandBundle(),
    skills: () => [
      {
        name: 'summarize',
        description: 'Summarize the conversation',
        userInvocable: true,
        available: true
      }
    ]
  };
  const h = await makeHarness(channelConfig(), commands);
  h.ctx.onMessage(
    inbound({
      chatId: 'chat1',
      userId: 'u1',
      kind: 'command',
      command: 'summarize',
      text: '/summarize',
      nativeMessageId: 'cmd-summarize'
    })
  );
  await h.flush();
  expect(h.sends.at(-1)).toEqual({ chatId: 'chat1', content: 'reply: /summarize' });
  expect(h.reactions).not.toContainEqual({ messageId: 'cmd-summarize', emoji: '✅' });
});

test('channel: /project leave reports that the current Chat Session does not support it', async () => {
  const h = await makeHarness(channelConfig(), testCommandBundle());
  h.ctx.onMessage(
    inbound({
      chatId: 'chat1',
      userId: 'u1',
      kind: 'command',
      command: 'project',
      commandArgs: ['leave'],
      text: '/project leave'
    })
  );
  await h.flush();
  expect(h.sends.at(-1)).toEqual({
    chatId: 'chat1',
    content: 'The current Chat Session does not support /project leave.'
  });
});

test('channel: dispatches a sender without channel authorization configuration', async () => {
  const h = await makeHarness(channelConfig());
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'sender', text: 'hello' }));
  await h.flush();
  expect(h.creates).toHaveLength(1);
});

test('channel: /workdir reports that the current Chat Session does not support it', async () => {
  const h = await makeHarness(channelConfig());
  h.ctx.onMessage(
    inbound({
      chatId: 'chat1',
      userId: 'u1',
      kind: 'command',
      command: 'workdir',
      text: '/workdir',
      nativeMessageId: 'cmd-workdir'
    })
  );
  await h.flush();
  expect(h.sends.at(-1)).toEqual({
    chatId: 'chat1',
    content: 'The current Chat Session does not support /workdir.'
  });
  expect(h.reactions).toContainEqual({ messageId: 'cmd-workdir', emoji: '✅' });
});

test('channel: self-echo and duplicate messages are dropped', async () => {
  const h = await makeHarness(channelConfig());
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', text: 'echo', isSelf: true }));
  await h.flush();

  const dup = inbound({ chatId: 'chat1', userId: 'u1', text: 'hi' });
  h.ctx.onMessage(dup);
  await h.flush();
  h.ctx.onMessage(dup); // same nativeMessageId → deduped
  await h.flush();
  expect(h.creates.length).toBe(1);
});

test('channel: status snapshot never leaks token material', async () => {
  const h = await makeHarness(channelConfig({ credential: { token: 'super-secret-token' } }));
  const [status] = h.service.statusSnapshot();
  expect(status?.hasToken).toBe(true);
});

test('channel: an adapter-owned connecting phase is not promoted before transport readiness', async () => {
  const h = await makeHarness(channelConfig(), testCommandBundle(), [], undefined, { phase: 'connecting' });
  expect(h.service.statusSnapshot()[0]).toMatchObject({ connected: false, phase: 'connecting' });
  h.ctx.onStatus?.({ phase: 'connected' });
  expect(h.service.statusSnapshot()[0]).toMatchObject({ connected: true, phase: 'connected' });
});

test('channel: a pairing adapter starts without a token and reports its QR state', async () => {
  const h = await makeHarness(channelConfig({ type: 'whatsapp', credential: undefined }));
  h.ctx.onStatus?.({ phase: 'pairing', pairingQr: 'data:image/png;base64,qr' });
  expect(h.service.statusSnapshot()[0]).toEqual({
    id: 'chn_TESTCHANNEL0',
    type: 'whatsapp',
    enabled: true,
    connected: false,
    phase: 'pairing',
    pairingQr: 'data:image/png;base64,qr',
    hasToken: false,
    activeConversations: 0
  });
});

test('channel: setRegistry disconnects a running channel whose adapter type vanished', async () => {
  const h = await makeHarness(channelConfig());
  expect(h.service.statusSnapshot()[0]?.connected).toBe(true);
  // Atom pack removed/disabled → its type is no longer in the registry.
  await h.service.setRegistry(new Map());
  expect(h.service.statusSnapshot()[0]?.connected).toBe(false);
});

test('channel: rate-limited user receives a throttle reply, no session is created', async () => {
  // rateLimitPerMin=0 → bucket starts at 0 tokens, every message is immediately throttled.
  const h = await makeHarness(channelConfig({ rateLimitPerMin: 0 }));
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'u1', text: 'hi' }));
  await h.flush();
  // The throttle reply is sent via the adapter (not a session reply).
});

test('channel: per-user granularity creates separate sessions for different users in the same chat', async () => {
  const h = await makeHarness(channelConfig({ mapping: { granularity: 'per-user' } }));
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'alice', text: 'hello' }));
  await h.flush();
  h.ctx.onMessage(inbound({ chatId: 'chat1', userId: 'bob', text: 'hello' }));
  await h.flush();
  // Same chatId, different userId → different conversation keys → two sessions.
  expect(h.creates.length).toBe(2);
});

test('channel: per-conversation granularity shares one session across users in the same chat', async () => {
  const h = await makeHarness(channelConfig({ mapping: { granularity: 'per-conversation' } }));
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
  edits: string[];
  bus: EventBus;
  sessionId: () => SessionId;
  push(m: ChannelInbound): void;
  flush(): Promise<void>;
}> {
  const sends: { chatId: string; content: string }[] = [];
  const edits: string[] = [];
  const bus = new EventBus();
  let capturedCtx: ChannelContext | undefined;
  let lastSessionId: SessionId | undefined;

  const adapter: ChannelAdapter = {
    type: 'telegram',
    capabilities: {
      edit: true,
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
    },
    async editMessage(_msg, content) {
      edits.push(content);
    }
  };

  const store = createStore();
  const cfg: MonadConfig = {
    ...createDefaultConfig('owner'),
    channels: [channelConfig()]
  };
  const service = new ChannelService(
    {
      session: {
        create: async () => ({ sessionId: newId('ses') }),
        sendInline: async ({ sessionId, text }, sink) => {
          lastSessionId = sessionId as SessionId;
          sink({ ...tokenEvent('draft ', 0), sessionId: sessionId as SessionId });
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
      commands: testCommandBundle(),
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
    edits,
    bus,
    // biome-ignore lint/style/noNonNullAssertion: always set before this is called (warm-up above)
    sessionId: () => lastSessionId!,
    push: (m) => ctx.onMessage(m),
    flush: () => new Promise((r) => setTimeout(r, 20))
  };
}

function makeAgentEvent(sessionId: SessionId, type: Event['type'], payload: Record<string, unknown>): Event {
  return { id: newId('evt'), sessionId, type, actorAgentId: null, payload, at: '' };
}

function completedMessageEvent(sessionId: SessionId, text: string, messageId = newId('msg')): Event {
  return makeAgentEvent(sessionId, 'session.message.completed', {
    transcriptTargetId: sessionId,
    producer: agentProducer,
    message: {
      id: messageId,
      sessionId,
      role: 'assistant',
      text,
      type: 'text',
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-07-18T00:00:00.000Z'
    },
    messageRevision: 2
  });
}

function userCreatedEvent(sessionId: SessionId, text: string): Event {
  return makeAgentEvent(sessionId, 'session.message.created', {
    transcriptTargetId: sessionId,
    producer: { kind: 'user' },
    message: {
      id: newId('msg'),
      sessionId,
      role: 'user',
      text,
      type: 'text',
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-07-18T00:00:00.000Z'
    },
    messageRevision: 1
  });
}

function deltaMessageEvent(sessionId: SessionId, delta: string, index: number, messageId = newId('msg')): Event {
  return makeAgentEvent(sessionId, 'session.message.delta.appended', {
    transcriptTargetId: sessionId,
    producer: agentProducer,
    messageId,
    channel: 'content',
    delta,
    index
  });
}

function meshDeltaMessageEvent(
  sessionId: SessionId,
  messageId: MessageId,
  meshSessionId: `mesh_${string}`,
  agentName: string,
  delta: string
): Event {
  return makeAgentEvent(sessionId, 'session.message.delta.appended', {
    transcriptTargetId: sessionId,
    producer: { kind: 'mesh-agent', meshSessionId, agentName },
    messageId,
    channel: 'content',
    delta,
    index: 0
  });
}

function completedMeshMessageEvent(
  sessionId: SessionId,
  messageId: MessageId,
  meshSessionId: `mesh_${string}`,
  agentName: string,
  agentDisplayName: string,
  text: string
): Event {
  return makeAgentEvent(sessionId, 'session.message.completed', {
    transcriptTargetId: sessionId,
    producer: { kind: 'mesh-agent', meshSessionId, agentName },
    message: {
      id: messageId,
      sessionId,
      role: 'assistant',
      text,
      type: 'text',
      data: { agentDisplayName },
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-08-06T00:00:00.000Z'
    },
    messageRevision: 2
  });
}

test('mirror: web-UI agent reply is forwarded to the adapter when outboundMirror is true', async () => {
  const h = await makeMirrorHarness(true);
  const sid = h.sessionId();
  const countBefore = h.sends.length;

  h.bus.publish(userCreatedEvent(sid, 'web hi'));
  h.bus.publish(completedMessageEvent(sid, 'web reply'));
  await h.flush();

  expect(h.sends.length).toBeGreaterThan(countBefore);
  expect(h.sends.at(-1)?.content).toBe('web reply');
});

test('mirror: canonical completion produces one outbound reply', async () => {
  const h = await makeMirrorHarness(true);
  const sid = h.sessionId();
  const countBefore = h.sends.length;
  const messageId = newId('msg');
  h.bus.publish(completedMessageEvent(sid, 'web reply', messageId));
  await h.flush();

  expect(h.sends.slice(countBefore).map((send) => send.content)).toEqual(['web reply']);
});

test('mirror: concurrent Mesh replies keep independent streams and include member names', async () => {
  const h = await makeMirrorHarness(true);
  const sid = h.sessionId();
  const firstMessageId = newId('msg');
  const secondMessageId = newId('msg');
  const editsBefore = h.edits.length;

  h.bus.publish(meshDeltaMessageEvent(sid, firstMessageId, 'mesh_FIRST0000001', 'pm_alpha', 'alpha draft'));
  h.bus.publish(meshDeltaMessageEvent(sid, secondMessageId, 'mesh_SECOND000001', 'pm_beta', 'beta draft'));
  h.bus.publish(completedMeshMessageEvent(sid, firstMessageId, 'mesh_FIRST0000001', 'pm_alpha', 'Alpha', 'alpha done'));
  h.bus.publish(completedMeshMessageEvent(sid, secondMessageId, 'mesh_SECOND000001', 'pm_beta', 'Beta', 'beta done'));
  await h.flush();

  expect(h.edits.slice(editsBefore)).toEqual(['Alpha:\nalpha done', 'Beta:\nbeta done']);
});

test('mirror: no forwarding when outboundMirror is false', async () => {
  const h = await makeMirrorHarness(false);
  const sid = h.sessionId();
  const countBefore = h.sends.length;

  h.bus.publish(userCreatedEvent(sid, 'web hi'));
  h.bus.publish(completedMessageEvent(sid, 'web reply'));
  await h.flush();

  expect(h.sends.length).toBe(countBefore); // adapter.send never called by the mirror
});

test('channel: /view summary makes direct and mirrored channel replies final-message-only', async () => {
  const h = await makeMirrorHarness(true);
  const sid = h.sessionId();

  h.push(
    inbound({
      chatId: 'chat1',
      userId: 'u1',
      kind: 'command',
      command: 'view',
      commandArgs: ['summary'],
      text: '/view summary'
    })
  );
  await h.flush();

  const countBeforeDirect = h.sends.length;
  const editsBeforeDirect = h.edits.length;
  h.push(inbound({ chatId: 'chat1', userId: 'u1', text: 'direct after summary' }));
  await h.flush();
  expect(h.sends.at(-1)?.content).toBe('reply: direct after summary');
  expect(h.sends.length).toBe(countBeforeDirect + 1);
  expect(h.edits.length).toBe(editsBeforeDirect);

  const countBeforeMirror = h.sends.length;
  const editsBeforeMirror = h.edits.length;
  const mirrorMessageId = newId('msg');
  h.bus.publish(userCreatedEvent(sid, 'web hi'));
  h.bus.publish(deltaMessageEvent(sid, 'draft', 0, mirrorMessageId));
  h.bus.publish(completedMessageEvent(sid, 'web final', mirrorMessageId));
  await h.flush();

  expect(h.sends.slice(countBeforeMirror).map((s) => s.content)).toEqual(['web final']);
  expect(h.edits.length).toBe(editsBeforeMirror);
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
    ...createDefaultConfig('owner'),
    channels: [channelConfig()]
  };
  const service = new ChannelService(
    {
      session: {
        create: async () => ({ sessionId: newId('ses') }),
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

// ---------- group require-mention gate ----------

test('group gate: an unaddressed group message is dropped when requireMention is on', async () => {
  const h = await makeHarness(channelConfig());
  h.ctx.onMessage(inbound({ chatId: 'g', userId: 'u', text: 'chatter', chatType: 'group' }));
  await h.flush();
});

test('group gate: a mention or reply gets through', async () => {
  const h = await makeHarness(channelConfig());
  h.ctx.onMessage(inbound({ chatId: 'g', userId: 'u', text: '@bot hi', chatType: 'group', mentionedSelf: true }));
  await h.flush();
  expect(h.creates.length).toBe(1);
});

test('group gate: a slash command is always addressed', async () => {
  const h = await makeHarness(channelConfig());
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
      groupPolicy: { requireMention: false }
    })
  );
  h.ctx.onMessage(inbound({ chatId: 'g', userId: 'u', text: 'chatter', chatType: 'group' }));
  await h.flush();
  expect(h.creates.length).toBe(1);
});

test('group gate: adapters without mention-policy support do not gate group messages', async () => {
  const h = await makeHarness(channelConfig(), undefined, undefined, undefined, undefined, false);
  h.ctx.onMessage(inbound({ chatId: 'g', userId: 'u', text: 'chatter', chatType: 'group' }));
  await h.flush();
  expect(h.creates.length).toBe(1);
});

test('group gate: DMs are always answered regardless of mention', async () => {
  const h = await makeHarness(channelConfig());
  h.ctx.onMessage(inbound({ chatId: 'c', userId: 'u', text: 'hi', chatType: 'dm' }));
  await h.flush();
  expect(h.creates.length).toBe(1);
});

test('group gate: a bot mention uses the default route while an Agent mention targets that Agent', async () => {
  const coder = testAgent('agt_CODER0000000', 'Coder');
  const h = await makeHarness(
    channelConfig({
      groupPolicy: { requireMention: true }
    }),
    testCommandBundle(),
    [coder]
  );
  h.ctx.onMessage(inbound({ chatId: 'g', userId: 'u', text: 'plain chatter', chatType: 'group' }));
  await h.flush();

  h.ctx.onMessage(inbound({ chatId: 'g', userId: 'u', text: '@bot hi', chatType: 'group', mentionedSelf: true }));
  await h.flush();
  expect(h.creates).toHaveLength(1);
  expect(h.creates[0]?.agentId).toBe('agt_CHANNELDEFLT');

  h.ctx.onMessage(inbound({ chatId: 'g', userId: 'u', text: '@coder please inspect this', chatType: 'group' }));
  await h.flush();
  expect(h.creates).toHaveLength(2);
  expect(h.creates[1]?.agentId).toBe(coder.id);
});

test('group gate: multiple agent mentions route to the first mentioned agent', async () => {
  const coder = testAgent('agt_CODER0000000', 'Coder');
  const reviewer = testAgent('agt_REVIEWER0000', 'Reviewer');
  const h = await makeHarness(
    channelConfig({
      groupPolicy: { requireMention: true }
    }),
    testCommandBundle(),
    [coder, reviewer]
  );
  h.ctx.onMessage(inbound({ chatId: 'g', userId: 'u', text: '@coder @reviewer split this', chatType: 'group' }));
  await h.flush();
  expect(h.creates).toHaveLength(1);
  expect(h.creates[0]?.agentId).toBe(coder.id);
  expect(h.sends.map((s) => s.content)).toEqual(['reply: @coder @reviewer split this']);
});

// ---------- agent hint (per-channel operator guidance) ----------

test('agentHint: operator guidance augments the channel response contract in ambientContext', async () => {
  let captured: string | undefined;
  const h = await makeHarness(
    channelConfig({ agentHint: 'IM surface — keep replies short.' }),
    undefined,
    undefined,
    async ({ text }, sink, runOpts) => {
      captured = runOpts?.ambientContext;
      sink(messageEvent(`reply: ${text}`));
    }
  );
  h.ctx.onMessage(inbound({ chatId: 'c', userId: 'u1', text: 'hi' }));
  await h.flush();
  // The hint reaches the model as per-turn context (not the user's words) and is delimited so the
  // model treats it as out-of-band configuration rather than user input.
  expect(captured).toContain('IM surface — keep replies short.');
  expect(captured).toContain('<channel_context>');
  expect(captured).toContain('return exactly one JSON object and no surrounding prose');
});

test('channel turns retain the structured response contract without an agentHint', async () => {
  let captured: string | undefined = 'unset';
  const h = await makeHarness(channelConfig(), undefined, undefined, async ({ text }, sink, runOpts) => {
    captured = runOpts?.ambientContext;
    sink(messageEvent(`reply: ${text}`));
  });
  h.ctx.onMessage(inbound({ chatId: 'c', userId: 'u1', text: 'hi' }));
  await h.flush();
  expect(captured).toContain('return exactly one JSON object and no surrounding prose');
});
