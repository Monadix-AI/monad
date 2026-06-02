import type { SessionId, UIItem } from '@monad/protocol';

import { afterEach, describe, expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, TRANSPORTS, type TransportHandle } from '../helpers.ts';

function json(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

for (const kind of TRANSPORTS) {
  describe(`resolve UI messages over ${kind}`, () => {
    let transport: TransportHandle | undefined;

    afterEach(async () => {
      await transport?.stop();
    });

    test('returns ordered active lookup-only items without changing the UI timeline', async () => {
      const handlers = buildHandlers(mockModel(['unused']));
      transport = serveTransport(kind, createHttpTransport(handlers));
      const created = await transport.fetch('/v1/sessions', json({ title: 'reply previews' }));
      expect(created.status).toBe(201);
      const sessionId = ((await created.json()) as { sessionId: SessionId }).sessionId;
      const targetId = newId('msg');
      handlers.store.insertMessage(targetId, sessionId, 'reply target', '2026-07-21T00:00:00.000Z', 'assistant');
      const before = await transport.fetch(`/v1/sessions/${sessionId}/ui-items`);
      expect(before.status).toBe(200);
      const beforeItems = ((await before.json()) as { items: UIItem[] }).items;

      const response = await transport.fetch(
        `/v1/sessions/${sessionId}/ui-messages/resolve`,
        json({ messageIds: [targetId, targetId, newId('msg')] })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        items: [
          {
            kind: 'message',
            id: targetId,
            role: 'assistant',
            parts: [{ type: 'text', text: 'reply target' }],
            replyable: true,
            status: 'done',
            seq: '2026-07-21T00:00:00.000Z'
          }
        ]
      });
      const after = await transport.fetch(`/v1/sessions/${sessionId}/ui-items`);
      expect(after.status).toBe(200);
      expect(((await after.json()) as { items: UIItem[] }).items).toEqual(beforeItems);
      handlers.store.close();
    });
  });
}
