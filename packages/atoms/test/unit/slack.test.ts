// Inbound normalization conformance for the Slack adapter (Socket Mode messages and slash commands).

import type { ChannelInbound } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import { createSlackAdapter, normalizeSlackMessage, normalizeSlackSlashCommand } from '../../src/channels/slack.ts';

test('S1: channel_type maps im→dm, channel→channel, mpim/group→group', () => {
  const at = (channel_type: string) =>
    normalizeSlackMessage({ type: 'message', channel: 'C', user: 'U', ts: '1', text: 'x', channel_type }).chatType;
  expect(at('im')).toBe('dm');
  expect(at('channel')).toBe('channel');
  expect(at('mpim')).toBe('group');
  expect(at('group')).toBe('group');
});

test('S2: ts is the native message id; thread_ts is threadId', () => {
  const ev = normalizeSlackMessage({
    type: 'message',
    channel: 'C',
    user: 'U',
    ts: '1700.001',
    thread_ts: '1699.999',
    text: 'hi'
  });
  expect(ev.nativeMessageId).toBe('1700.001');
  expect(ev.threadId).toBe('1699.999');
});

test('S3: mentionedSelf from the <@U…> token', () => {
  const ev = normalizeSlackMessage(
    { type: 'message', channel: 'C', user: 'U', ts: '1', text: 'hey <@UBOT> ping', channel_type: 'channel' },
    'UBOT'
  );
  expect(ev.mentionedSelf).toBe(true);
  const plain = normalizeSlackMessage(
    { type: 'message', channel: 'C', user: 'U', ts: '1', text: 'chatter', channel_type: 'channel' },
    'UBOT'
  );
  expect(plain.mentionedSelf).toBe(false);
});

test('S4: isSelf set for the bot user id or any bot_id (echo guard)', () => {
  expect(
    normalizeSlackMessage({ type: 'message', channel: 'C', user: 'UBOT', ts: '1', text: 'x' }, 'UBOT').isSelf
  ).toBe(true);
  expect(
    normalizeSlackMessage({ type: 'message', channel: 'C', ts: '1', text: 'x', bot_id: 'B1' }, 'UBOT').isSelf
  ).toBe(true);
  expect(normalizeSlackMessage({ type: 'message', channel: 'C', user: 'U2', ts: '1', text: 'x' }, 'UBOT').isSelf).toBe(
    false
  );
});

test('S5: leading / is a command', () => {
  const ev = normalizeSlackMessage({
    type: 'message',
    channel: 'C',
    user: 'U',
    ts: '1',
    text: '/Reset now',
    channel_type: 'im'
  });
  expect(ev.kind).toBe('command');
  expect(ev.command).toBe('reset');
  expect(ev.commandArgs).toEqual(['now']);
});

test('S6: a Socket Mode slash command normalizes into the shared command path', () => {
  expect(
    normalizeSlackSlashCommand(
      {
        channel_id: 'C123',
        channel_name: 'general',
        command: '/project',
        response_url: 'https://hooks.slack.com/commands/T/B/token',
        text: 'use Monad Core',
        user_id: 'U123',
        user_name: 'alice'
      },
      'env-1'
    )
  ).toMatchObject({
    chatId: 'C123',
    userId: 'U123',
    text: '/project use Monad Core',
    kind: 'command',
    command: 'project',
    commandArgs: ['use', 'Monad', 'Core'],
    nativeMessageId: 'slash:env-1',
    replyTo: 'slash:env-1',
    senderDisplay: 'alice',
    chatType: 'channel',
    mentionedSelf: true
  });
});

test('S7: the adapter ACKs slash commands and responds privately through response_url', async () => {
  const originalFetch = globalThis.fetch;
  const OriginalWebSocket = globalThis.WebSocket;
  const received: ChannelInbound[] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const sockets: FakeWebSocket[] = [];

  class FakeWebSocket {
    static readonly OPEN = 1;
    readonly readyState = FakeWebSocket.OPEN;
    readonly sent: string[] = [];
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor() {
      sockets.push(this);
    }

    close(): void {}
    send(data: string): void {
      this.sent.push(data);
    }
  }

  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith('/auth.test')) return Response.json({ ok: true, user_id: 'UBOT' });
      if (url.endsWith('/apps.connections.open')) return Response.json({ ok: true, url: 'wss://socket.slack.test' });
      if (url === 'https://hooks.slack.com/commands/T/B/token') return new Response('ok');
      throw new Error(`unexpected Slack request: ${url}`);
    },
    { preconnect: originalFetch.preconnect }
  );
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  try {
    const adapter = createSlackAdapter({
      config: { id: 'chn_SLACKTEST000', type: 'slack', label: 'Slack' },
      secrets: { token: 'xoxb-test', appToken: 'xapp-test' },
      signal: new AbortController().signal,
      log: () => {},
      onMessage: (message) => received.push(message)
    });
    await adapter.connect();
    for (let i = 0; i < 10 && sockets.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    sockets[0]?.onmessage?.({
      data: JSON.stringify({
        type: 'slash_commands',
        envelope_id: 'env-1',
        accepts_response_payload: true,
        payload: {
          channel_id: 'C123',
          channel_name: 'general',
          command: '/project',
          response_url: 'https://hooks.slack.com/commands/T/B/token',
          text: 'current',
          user_id: 'U123',
          user_name: 'alice'
        }
      })
    } as MessageEvent);

    expect(sockets[0]?.sent.map((payload) => JSON.parse(payload))).toContainEqual({ envelope_id: 'env-1' });
    expect(received).toHaveLength(1);
    await adapter.send('C123', 'Current Project: Monad.', { replyTo: 'slash:env-1' });
    const response = requests.find((request) => request.url === 'https://hooks.slack.com/commands/T/B/token');
    expect(response?.init?.method).toBe('POST');
    expect(JSON.parse(String(response?.init?.body))).toEqual({
      response_type: 'ephemeral',
      text: 'Current Project: Monad.'
    });
    await adapter.send('C123', 'More Projects', { replyTo: 'slash:env-1' });
    expect(
      requests
        .filter((request) => request.url === 'https://hooks.slack.com/commands/T/B/token')
        .map((request) => JSON.parse(String(request.init?.body)))
    ).toEqual([
      { response_type: 'ephemeral', text: 'Current Project: Monad.' },
      { response_type: 'ephemeral', text: 'More Projects' }
    ]);
    await expect(adapter.send('C123', 'Must stay private', { replyTo: 'slash:evicted-or-expired' })).rejects.toThrow(
      'slack slash response target is unavailable'
    );
    expect(requests.some((request) => request.url.endsWith('/chat.postMessage'))).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = OriginalWebSocket;
  }
});
