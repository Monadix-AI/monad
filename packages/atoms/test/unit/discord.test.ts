// Inbound normalization conformance for the Discord adapter. Channel/renderer-level behaviour is
// exercised in apps/monad against a mock adapter; here we pin the payload→ChannelInbound rules.

import type { ChannelContext, ChannelInbound } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import {
  createDiscordAdapter,
  discordApplicationCommands,
  normalizeDiscordInteraction,
  normalizeDiscordMessage
} from '../../src/channels/discord.ts';

function fakeContext(): ChannelContext {
  return {
    config: { type: 'discord' } as ChannelContext['config'],
    log: () => {},
    onMessage: () => {},
    secrets: { token: 'test-token' },
    signal: new AbortController().signal
  } as ChannelContext;
}

test('D0: malformed Discord REST responses are rejected at the channel boundary', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => Response.json({ id: 42 }), { preconnect: originalFetch.preconnect });
  try {
    const adapter = createDiscordAdapter(fakeContext());
    await expect(adapter.send('channel', 'hello')).rejects.toThrow();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('D0.1: a HELLO frame with a null event name starts the Gateway session', async () => {
  const originalFetch = globalThis.fetch;
  const OriginalWebSocket = globalThis.WebSocket;
  const abort = new AbortController();
  const sockets: FakeWebSocket[] = [];

  class FakeWebSocket {
    static readonly OPEN = 1;
    readonly readyState = FakeWebSocket.OPEN;
    readonly sent: string[] = [];
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor() {
      sockets.push(this);
    }

    close(): void {
      this.onclose?.();
    }

    send(data: string): void {
      this.sent.push(data);
    }
  }

  globalThis.fetch = Object.assign(async () => Response.json({ id: 'bot' }), { preconnect: originalFetch.preconnect });
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  try {
    const adapter = createDiscordAdapter({ ...fakeContext(), signal: abort.signal });
    await adapter.connect();
    sockets[0]?.onmessage?.({
      data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 }, s: null, t: null })
    } as MessageEvent);

    expect(sockets[0]?.sent.map((payload) => JSON.parse(payload))).toEqual([
      {
        op: 2,
        d: {
          token: 'test-token',
          intents: (1 << 9) | (1 << 12) | (1 << 15),
          properties: { os: 'linux', browser: 'monad', device: 'monad' }
        }
      }
    ]);
    abort.abort();
    await adapter.disconnect();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = OriginalWebSocket;
  }
});

test('D0.2: Discord reports connected only after Gateway READY and preserves close diagnostics', async () => {
  const originalFetch = globalThis.fetch;
  const OriginalWebSocket = globalThis.WebSocket;
  const abort = new AbortController();
  const statuses: Array<{ phase: string; error?: string }> = [];
  const sockets: FakeWebSocket[] = [];

  class FakeWebSocket {
    static readonly OPEN = 1;
    readonly readyState = FakeWebSocket.OPEN;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor() {
      sockets.push(this);
    }

    close(): void {}
    send(): void {}
  }

  globalThis.fetch = Object.assign(async () => Response.json({ id: 'bot' }), { preconnect: originalFetch.preconnect });
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  try {
    const adapter = createDiscordAdapter({
      ...fakeContext(),
      signal: abort.signal,
      onStatus: (status) => statuses.push(status)
    });
    await adapter.connect();
    expect(statuses).toEqual([{ phase: 'connecting' }]);

    sockets[0]?.onmessage?.({
      data: JSON.stringify({
        op: 0,
        d: { user: { id: 'bot' }, application: { id: 'app' } },
        s: 1,
        t: 'READY'
      })
    } as MessageEvent);
    expect(statuses.at(-1)).toEqual({ phase: 'connected' });

    sockets[0]?.onclose?.({ code: 4014, reason: 'Disallowed intent' } as CloseEvent);
    expect(statuses.at(-1)).toEqual({
      phase: 'error',
      error: 'Discord Gateway closed (4014: Disallowed intent)'
    });
    abort.abort();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = OriginalWebSocket;
  }
});

test('D1: a DM (no guild_id) → chatType dm; guild → group', () => {
  expect(normalizeDiscordMessage({ id: '1', channel_id: 'c', author: { id: 'u' }, content: 'hi' }).chatType).toBe('dm');
  expect(
    normalizeDiscordMessage({ id: '1', channel_id: 'c', guild_id: 'g', author: { id: 'u' }, content: 'hi' }).chatType
  ).toBe('group');
});

test('D2: a leading / is a command (lowercased) with args', () => {
  const ev = normalizeDiscordMessage({ id: '1', channel_id: 'c', author: { id: 'u' }, content: '/New foo bar' });
  expect(ev.kind).toBe('command');
  expect(ev.command).toBe('new');
  expect(ev.commandArgs).toEqual(['foo', 'bar']);
});

test('D2.1: a command addressed through a leading bot mention is normalized as a command', () => {
  for (const content of ['<@42> /Project', '<@!42>   /project use 2']) {
    const ev = normalizeDiscordMessage(
      { id: '1', channel_id: 'c', guild_id: 'g', author: { id: 'u' }, content, mentions: [{ id: '42' }] },
      '42'
    );
    expect(ev.kind).toBe('command');
    expect(ev.command).toBe('project');
  }

  expect(
    normalizeDiscordMessage(
      {
        id: '2',
        channel_id: 'c',
        guild_id: 'g',
        author: { id: 'u' },
        content: '<@42> /project use 2',
        mentions: [{ id: '42' }]
      },
      '42'
    )
  ).toMatchObject({ text: '/project use 2', commandArgs: ['use', '2'], mentionedSelf: true });
});

test('D2.2: a native Discord subcommand interaction becomes a shared channel command', () => {
  expect(
    normalizeDiscordInteraction({
      id: 'interaction-id',
      application_id: 'bot',
      token: 'interaction-token',
      type: 2,
      channel_id: 'channel',
      guild_id: 'guild',
      member: { user: { id: 'user', username: 'alice', global_name: 'Alice' } },
      data: {
        type: 1,
        name: 'project',
        options: [{ type: 1, name: 'use', options: [{ type: 3, name: 'target', value: 'Monad Core' }] }]
      }
    })
  ).toMatchObject({
    chatId: 'channel',
    userId: 'user',
    text: '/project use Monad Core',
    kind: 'command',
    command: 'project',
    commandArgs: ['use', 'Monad Core'],
    nativeMessageId: 'interaction:interaction-id',
    replyTo: 'interaction:interaction-id',
    senderDisplay: 'Alice',
    chatType: 'group'
  });
});

test('D2.3: host command metadata maps to Discord commands, subcommands, and typed options', () => {
  expect(
    discordApplicationCommands([
      {
        command: 'project',
        description: 'Choose a Project',
        subcommands: [
          { id: 'list', name: 'List', description: 'List Projects', aliases: [] },
          {
            id: 'use',
            name: 'Use',
            description: 'Switch Project',
            aliases: [],
            args: [{ name: 'target', type: 'string', required: true }]
          }
        ]
      },
      {
        command: 'view',
        description: 'Change view',
        args: [{ name: 'mode', type: 'enum', values: [{ id: 'summary' }, { id: 'detail', name: 'Detail' }] }]
      },
      { command: 'not.valid', description: 'Invalid Discord command name' }
    ])
  ).toEqual([
    {
      name: 'project',
      description: 'Choose a Project',
      type: 1,
      options: [
        { type: 1, name: 'list', description: 'List Projects' },
        {
          type: 1,
          name: 'use',
          description: 'Switch Project',
          options: [{ type: 3, name: 'target', description: 'target', required: true }]
        }
      ]
    },
    {
      name: 'view',
      description: 'Change view',
      type: 1,
      options: [
        {
          type: 3,
          name: 'mode',
          description: 'mode',
          required: false,
          choices: [
            { name: 'summary', value: 'summary' },
            { name: 'Detail', value: 'detail' }
          ]
        }
      ]
    }
  ]);
});

test('D2.4: the adapter defers a native interaction and edits its private original response', async () => {
  const originalFetch = globalThis.fetch;
  const OriginalWebSocket = globalThis.WebSocket;
  const abort = new AbortController();
  const received: ChannelInbound[] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const sockets: FakeWebSocket[] = [];

  class FakeWebSocket {
    static readonly OPEN = 1;
    readonly readyState = FakeWebSocket.OPEN;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor() {
      sockets.push(this);
    }

    close(): void {
      this.onclose?.();
    }

    send(): void {}
  }

  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith('/users/@me')) return Response.json({ id: 'bot-user' });
      if (url.endsWith('/oauth2/applications/@me')) return Response.json({ id: 'bot' });
      if (url.includes('/interactions/') && url.endsWith('/callback')) {
        return new Response(null, { status: 204 });
      }
      if (url.includes('/webhooks/') && url.endsWith('/messages/@original')) return Response.json({ id: 'reply' });
      if (url.includes('/webhooks/') && url.endsWith('?wait=true')) return Response.json({ id: 'followup' });
      if (url.endsWith('/applications/bot/commands')) return Response.json([]);
      throw new Error(`unexpected Discord request: ${url}`);
    },
    { preconnect: originalFetch.preconnect }
  );
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  try {
    const adapter = createDiscordAdapter({
      ...fakeContext(),
      signal: abort.signal,
      onMessage: (message) => received.push(message)
    });
    await adapter.connect();
    await adapter.setCommands?.([{ command: 'project', description: 'Choose a Project' }]);
    sockets[0]?.onmessage?.({
      data: JSON.stringify({
        op: 0,
        s: 1,
        t: 'INTERACTION_CREATE',
        d: {
          id: 'interaction-id',
          application_id: 'bot',
          token: 'interaction-token',
          type: 2,
          channel_id: 'channel',
          guild_id: 'guild',
          member: { user: { id: 'user', username: 'alice' } },
          data: { type: 1, name: 'project', options: [{ type: 1, name: 'list' }] }
        }
      })
    } as MessageEvent);
    for (let i = 0; i < 10 && received.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received).toHaveLength(1);
    expect(JSON.parse(String(requests.find((request) => request.url.includes('/callback'))?.init?.body))).toEqual({
      type: 5,
      data: { flags: 64 }
    });
    await adapter.send('channel', 'Project list', { replyTo: 'interaction:interaction-id' });
    const edit = requests.find((request) => request.url.includes('/messages/@original'));
    expect(edit?.init?.method).toBe('PATCH');
    expect(JSON.parse(String(edit?.init?.body))).toEqual({ content: 'Project list' });
    await adapter.send('channel', 'Project list continued', { replyTo: 'interaction:interaction-id' });
    const followup = requests.find((request) => request.url.endsWith('?wait=true'));
    expect(followup?.init?.method).toBe('POST');
    expect(JSON.parse(String(followup?.init?.body))).toEqual({
      content: 'Project list continued',
      flags: 64
    });
    await adapter.react?.({ chatId: 'channel', messageId: 'interaction:interaction-id' }, '✅');
    expect(requests.filter((request) => request.url.endsWith('/messages/@original'))).toHaveLength(1);
    await expect(
      adapter.send('channel', 'Must stay private', { replyTo: 'interaction:evicted-or-expired' })
    ).rejects.toThrow('discord interaction reply target is unavailable');
    expect(requests.some((request) => request.url.includes('/channels/channel/messages'))).toBe(false);

    sockets[0]?.onmessage?.({
      data: JSON.stringify({
        op: 0,
        s: 2,
        t: 'INTERACTION_CREATE',
        d: {
          id: 'effect-id',
          application_id: 'bot',
          token: 'effect-token',
          type: 2,
          channel_id: 'channel',
          member: { user: { id: 'user', username: 'alice' } },
          data: { type: 1, name: 'clear' }
        }
      })
    } as MessageEvent);
    for (let i = 0; i < 10 && received.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    await adapter.react?.({ chatId: 'channel', messageId: 'interaction:effect-id' }, '✅');
    const effectReceipt = requests.find((request) => request.url.includes('/webhooks/bot/effect-token/'));
    expect(JSON.parse(String(effectReceipt?.init?.body))).toEqual({ content: '✅' });

    abort.abort();
    await adapter.disconnect();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = OriginalWebSocket;
  }
});

test('D3: mentionedSelf from the mentions array or a reply to the bot', () => {
  const mention = normalizeDiscordMessage(
    { id: '1', channel_id: 'c', guild_id: 'g', author: { id: 'u' }, content: '<@42> hi', mentions: [{ id: '42' }] },
    '42'
  );
  expect(mention.mentionedSelf).toBe(true);
  const reply = normalizeDiscordMessage(
    {
      id: '2',
      channel_id: 'c',
      guild_id: 'g',
      author: { id: 'u' },
      content: 'hi',
      referenced_message: { id: '9', author: { id: '42' } }
    },
    '42'
  );
  expect(reply.mentionedSelf).toBe(true);
  expect(reply.replyTo).toBe('9');
  const plain = normalizeDiscordMessage(
    { id: '3', channel_id: 'c', guild_id: 'g', author: { id: 'u' }, content: 'chatter' },
    '42'
  );
  expect(plain.mentionedSelf).toBe(false);
});

test('D4: isSelf set when the author is the bot', () => {
  const m = { id: '1', channel_id: 'c', author: { id: '42' }, content: 'x' };
  expect(normalizeDiscordMessage(m, '42').isSelf).toBe(true);
  expect(normalizeDiscordMessage(m, '7').isSelf).toBe(false);
});

test('D5: golden guild message → normalized fields', () => {
  expect(
    normalizeDiscordMessage(
      {
        id: '7',
        channel_id: 'chan',
        guild_id: 'guild',
        author: { id: '42', username: 'alice', global_name: 'Alice' },
        content: 'hello'
      },
      '999'
    )
  ).toMatchObject({
    chatId: 'chan',
    userId: '42',
    text: 'hello',
    kind: 'text',
    nativeMessageId: '7',
    senderDisplay: 'Alice',
    chatType: 'group',
    isSelf: false
  });
});
