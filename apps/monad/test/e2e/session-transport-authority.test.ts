import type { OperationSource, SessionId } from '@monad/protocol';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, TRANSPORTS, type TransportHandle } from '../helpers.ts';

// Session origin is routing metadata, not write ownership. Interactive control-plane clients may
// continue or branch sessions created by HTTP, ACP, or a channel; scheduler-owned automation sessions
// remain isolated. Verify the same policy over BOTH TCP and the Unix socket.
for (const kind of TRANSPORTS) {
  describe(`session write authority over ${kind}`, () => {
    let t: TransportHandle;
    let handlers: ReturnType<typeof buildHandlers>;

    beforeAll(() => {
      handlers = buildHandlers(mockModel(['ok']));
      t = serveTransport(kind, createHttpTransport(handlers));
    });
    afterAll(() => t.stop());

    async function createOwnedBy(origin: OperationSource | undefined): Promise<SessionId> {
      const { sessionId } = await handlers.session.create({ title: 'auth', ...(origin ? { origin } : {}) });
      return sessionId;
    }

    const writeStatus = async (id: SessionId, path: string): Promise<number> =>
      (
        await t.fetch(`/v1/sessions/${id}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'hi' })
        })
      ).status;

    test('HTTP writes and branches every interactive session regardless of origin transport, but not automation', async () => {
      const http = await createOwnedBy({ surface: 'web', client: 'monad-web', transport: 'http' });
      const acp = await createOwnedBy({ surface: 'editor', client: 'zed', transport: 'acp' });
      const channel = await createOwnedBy({ surface: 'im', client: 'telegram', transport: 'channel' });
      const automation = await createOwnedBy({ surface: 'automation', client: 'cron', transport: 'http' });
      const legacy = await createOwnedBy(undefined);

      expect({
        acpBranch: await writeStatus(acp, '/branch'),
        acpSend: await writeStatus(acp, '/messages'),
        automationBranch: await writeStatus(automation, '/branch'),
        automationSend: await writeStatus(automation, '/messages'),
        channelBranch: await writeStatus(channel, '/branch'),
        channelSend: await writeStatus(channel, '/messages'),
        httpBranch: await writeStatus(http, '/branch'),
        httpSend: await writeStatus(http, '/messages'),
        legacyBranch: await writeStatus(legacy, '/branch'),
        legacySend: await writeStatus(legacy, '/messages')
      }).toEqual({
        acpBranch: 201,
        acpSend: 200,
        automationBranch: 403,
        automationSend: 403,
        channelBranch: 201,
        channelSend: 200,
        httpBranch: 201,
        httpSend: 200,
        legacyBranch: 201,
        legacySend: 200
      });
    });
  });
}
