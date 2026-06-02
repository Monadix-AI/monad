import type { ListMessagesResponse } from '../src/rpc/control.ts';

import { expect, test } from 'bun:test';

import { listMessagesResponseSchema } from '../src/rpc/control.ts';

test('message history snapshots carry the authoritative durable revision', () => {
  const response: ListMessagesResponse = {
    messages: [
      {
        id: 'msg_100000000000',
        sessionId: 'prj_100000000000',
        role: 'user' as const,
        text: 'hello',
        type: 'text',
        stream: { status: 'settled' as const },
        active: true,
        createdAt: '2026-07-18T14:00:00.000Z'
      }
    ],
    messageRevision: 3
  };
  expect(listMessagesResponseSchema.parse(response)).toEqual(response);
  expect(listMessagesResponseSchema.safeParse({ messages: response.messages }).success).toBe(false);
});
