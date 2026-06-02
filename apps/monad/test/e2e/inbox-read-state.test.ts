import type { Session } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, TRANSPORTS } from '../helpers.ts';

const session: Session = {
  id: 'ses_INBOXREAD001',
  title: 'Inbox read state',
  state: 'active',
  agentIds: [],
  archived: false,
  restoreCount: 0,
  createdAt: '2026-07-22T00:00:00.000Z',
  updatedAt: '2026-07-22T00:00:00.000Z'
};

for (const transport of TRANSPORTS) {
  test(`Inbox read controls persist over ${transport}`, async () => {
    const handlers = buildHandlers(mockModel());
    handlers._nativeAgentStore.insertSession(session);
    handlers._nativeAgentStore.insertMessage(
      'msg_INBOXREAD001',
      session.id,
      '@[name="zeke" id="human"] review this',
      '2026-07-22T00:00:01.000Z',
      'assistant'
    );
    const live = serveTransport(transport, createHttpTransport(handlers));

    try {
      const readAllResponse = await live.fetch('/v1/inbox/read-all', { method: 'POST' });
      const readAll = (await readAllResponse.json()) as { readAt: string; count: number };
      expect({ status: readAllResponse.status, count: readAll.count }).toEqual({ status: 200, count: 1 });

      const summaryResponse = await live.fetch('/v1/inbox/summary');
      expect({ status: summaryResponse.status, body: await summaryResponse.json() }).toEqual({
        status: 200,
        body: { unreadCount: 0, needsResponseCount: 0 }
      });

      const unreadResponse = await live.fetch('/v1/inbox/unread', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemKeys: ['mention:msg_INBOXREAD001'] })
      });
      expect({ status: unreadResponse.status, body: await unreadResponse.json() }).toEqual({
        status: 200,
        body: { itemKeys: ['mention:msg_INBOXREAD001'] }
      });

      const listResponse = await live.fetch('/v1/inbox/items?filter=unread&limit=100');
      const list = (await listResponse.json()) as { items: Array<{ itemKey: string; actionState: string }> };
      expect({
        status: listResponse.status,
        items: list.items.map((item) => ({ itemKey: item.itemKey, actionState: item.actionState }))
      }).toEqual({
        status: 200,
        items: [{ itemKey: 'mention:msg_INBOXREAD001', actionState: 'informational' }]
      });
    } finally {
      await live.stop();
      handlers._nativeAgentStore.close();
    }
  });
}
