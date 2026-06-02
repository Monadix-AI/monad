// Single-authority contract: the daemon exposes exactly one InteractionService, and every surface —
// the HTTP interactions plane, the JSON-RPC control plane, and the clarify handler group — reads that
// same instance's state. This drives state on the one instance and observes it through each surface,
// so the guarantee is behavioral, not "the production wiring happens to pass equal arguments".

import type { InteractionProducer, InteractionRequest } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { InteractionService } from '#/interactions/service.ts';
import { createHttpTransport } from '#/transports/http.ts';
import { createConnectionState, handleRpcMessage } from '#/transports/jsonrpc/index.ts';
import { buildHandlers, mockModel } from '../helpers.ts';

const source: InteractionProducer = { kind: 'atom-pack', packId: 'example.pack', atomId: 'configure' };
const confirmRequest: InteractionRequest = { type: 'confirm', title: 'Allow?' };

test('the HTTP plane, the JSON-RPC control plane, and the clarify handler all read the one instance', async () => {
  const interactions = new InteractionService({
    now: () => 0,
    createId: () => 'interaction-single-1',
    createLeaseToken: () => 'lease-single-1'
  });
  const handlers = buildHandlers(mockModel(), undefined, { interactions });
  const app = createHttpTransport(handlers);

  // A structured request placed directly on the instance appears on the HTTP interactions plane.
  void interactions.request(source, confirmRequest, { mode: 'background' });
  const listed = await app.handle(new Request('http://localhost/v1/interactions'));
  const listedBody = (await listed.json()) as { interactions: Array<{ id: string; state: string }> };
  expect(listedBody.interactions.map((i) => ({ id: i.id, state: i.state }))).toEqual([
    { id: 'interaction-single-1', state: 'pending' }
  ]);

  // The JSON-RPC control plane, dispatched over the same handlers, replays that same pending interaction.
  const rpcOut: unknown[] = [];
  await handleRpcMessage(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'control.subscribe', params: {} }),
    createConnectionState(),
    handlers,
    (message) => rpcOut.push(message)
  );
  expect(rpcOut).toContainEqual(
    expect.objectContaining({
      method: 'interactions.event',
      params: expect.objectContaining({
        event: expect.objectContaining({
          type: 'upsert',
          interaction: expect.objectContaining({ id: 'interaction-single-1' })
        })
      })
    })
  );

  // A clarification asked on the instance is resolvable through the clarify handler group — same object.
  const { sessionId: liveSession } = await handlers.session.create({ title: 'single-instance' });
  const clarify = interactions.askStructured(liveSession, { requestId: 'clarify_SINGLE0001', question: 'ship?' });
  for (let attempt = 0; attempt < 20 && interactions.pendingCount === 0; attempt += 1) await Promise.resolve();
  expect(await handlers.clarify.respond({ requestId: 'clarify_SINGLE0001', answer: 'ship' })).toMatchObject({
    status: 'answered',
    answer: 'ship'
  });
  expect(await clarify).toMatchObject({ status: 'answered', answer: 'ship' });
});
