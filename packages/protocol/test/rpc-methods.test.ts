import { expect, test } from 'bun:test';

import { messageGenerationFrameSchema } from '../src/rpc/control.ts';
import { METHOD_TABLE } from '../src/rpc/method-table.ts';
import { RPC_METHOD_PARAMS } from '../src/rpc/rpc-methods.ts';

test('path + body flatten into one params object on the wire', () => {
  const sid = 'ses_01KV8EP5YE7J';
  // sessions.update: path {id} ⊕ body {title?} → flat {id, title?}
  const update = RPC_METHOD_PARAMS['sessions.update'];
  expect(update.safeParse({ id: sid }).success).toBe(true);
  expect(update.safeParse({ id: sid, title: 'hi' }).success).toBe(true);
  expect(update.safeParse({ title: 'hi' }).success).toBe(false); // missing required path id

  // sessions.reset: path {id} only, no body → flat {id}
  const reset = RPC_METHOD_PARAMS['sessions.reset'];
  expect(reset.safeParse({ id: sid }).success).toBe(true);
  expect(reset.safeParse({}).success).toBe(false); // missing required path id
});

test('message generation frames validate the canonical event payload', () => {
  expect(() =>
    messageGenerationFrameSchema.parse({
      kind: 'event',
      event: {
        id: 'evt_01KV8EP5YE7J',
        sessionId: 'ses_01KV8EP5YE7J',
        type: 'session.message.delta.appended',
        actorAgentId: null,
        payload: { messageId: 'msg_01KV8EP5YE7J', delta: 'missing canonical identity' },
        at: '2026-07-19T00:00:00.000Z'
      }
    })
  ).toThrow();

  expect(() =>
    messageGenerationFrameSchema.parse({
      kind: 'snapshot',
      message: {
        id: 'msg_01KV8EP5YE7J',
        sessionId: 'ses_01KV8EP5YE7J',
        role: 'assistant',
        text: 'done',
        type: 'text',
        stream: { status: 'complete' },
        active: true,
        createdAt: '2026-07-19T00:00:00.000Z'
      },
      messageRevision: 2,
      deltas: [
        {
          id: 'evt_01KV8EP5YE7J',
          sessionId: 'ses_01KV8EP5YE7J',
          type: 'session.message.completed',
          actorAgentId: null,
          payload: {
            transcriptTargetId: 'ses_01KV8EP5YE7J',
            producer: { kind: 'agent', agentId: 'agt_01KV8EP5YE7J' },
            message: {
              id: 'msg_01KV8EP5YE7J',
              sessionId: 'ses_01KV8EP5YE7J',
              role: 'assistant',
              text: 'done',
              type: 'text',
              stream: { status: 'complete' },
              active: true,
              createdAt: '2026-07-19T00:00:00.000Z'
            },
            messageRevision: 2
          },
          at: '2026-07-19T00:00:00.000Z'
        }
      ]
    })
  ).toThrow();
});

test('subscription methods ack synchronously', () => {
  expect(METHOD_TABLE['control.subscribe'].result.safeParse({ subscribed: true }).success).toBe(true);
  expect(METHOD_TABLE['control.subscribe'].result.safeParse({ subscribed: false }).success).toBe(false);
  expect(
    RPC_METHOD_PARAMS['session.messageGeneration.subscribe'].safeParse({
      id: 'ses_01KV8EP5YE7J',
      messageId: 'msg_01KV8EP5YE7J',
      afterEventId: 'evt_01KV8EP5YE7J'
    }).success
  ).toBe(true);
  expect(
    RPC_METHOD_PARAMS['session.messageGeneration.subscribe'].safeParse({
      id: 'ses_01KV8EP5YE7J'
    }).success
  ).toBe(false);
});

test('RPC exposes only control-lifetime and message-scoped subscriptions', () => {
  expect(Object.keys(METHOD_TABLE).filter((method) => method.includes('subscribe'))).toEqual([
    'control.subscribe',
    'control.unsubscribe',
    'session.messageGeneration.subscribe',
    'session.messageGeneration.unsubscribe'
  ]);
});
