// The unified active-interaction lifecycle, across BOTH kinds on ONE service instance. Structured
// interactions and clarifications share a single `#pending` map and a single register/terminal
// transition; this proves each kind's terminal (submit / cancel / timeout / answer) removes exactly
// its own record and fires its own outcome, and that terminating one kind never disturbs the other.
// Per-kind behavior depth lives in service.test.ts (structured) and clarify.test.ts (clarify); this
// guards the cross-kind invariant the fold introduces.

import type {
  Event,
  InteractionEvent,
  InteractionPresenterCapabilities,
  InteractionProducer,
  InteractionRequest,
  TranscriptTargetId
} from '@monad/protocol';

import { expect, test } from 'bun:test';

import { InteractionService } from '#/interactions/service.ts';
import { EventBus } from '#/services/event-bus.ts';
import { createMessageIngress } from '#/services/messages/ingress.ts';
import { createStore } from '#/store/db/index.ts';

const sessionId = 'ses_TEST00000000' as TranscriptTargetId;
const source: InteractionProducer = { kind: 'atom-pack', packId: 'example.pack', atomId: 'configure' };
const confirmRequest: InteractionRequest = { type: 'confirm', title: 'Enable backend?' };
const fullCapabilities: InteractionPresenterCapabilities = {
  interactionTypes: ['confirm', 'select', 'form'],
  fieldTypes: ['string', 'secret', 'number', 'boolean', 'select'],
  supportsSecretInput: true,
  supportsBackgroundQueue: true
};

async function untilClarifyPending(service: InteractionService): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (service.pendingCount > 0) return;
    await Promise.resolve();
  }
  throw new Error('clarification did not register');
}

function harness() {
  let now = Date.parse('2026-07-13T08:00:00.000Z');
  let nextId = 0;
  let nextToken = 0;
  const store = createStore();
  const ingress = createMessageIngress({ store, bus: new EventBus(), targetExists: () => true });
  const structuredEvents: InteractionEvent[] = [];
  const service = new InteractionService({
    now: () => now,
    createId: () => `interaction-${++nextId}`,
    createLeaseToken: () => `lease-${++nextToken}`,
    clarify: { ingress, publish: (event: Event) => store.appendEvents([event]) }
  });
  service.subscribe((event) => structuredEvents.push(event));
  return { service, structuredEvents, advance: (ms: number) => (now += ms) };
}

test('both kinds are active on one instance, each projection scoped to its kind', async () => {
  const { service } = harness();
  void service.request(source, confirmRequest, { mode: 'background' });
  const clarify = service.askStructured(sessionId, { requestId: 'clarify_MATRIX0001', question: 'Which path?' });
  await untilClarifyPending(service);

  expect(service.listPending()).toEqual([
    expect.objectContaining({ id: 'interaction-1', mode: 'background', state: 'pending' })
  ]);
  expect(service.pendingCount).toBe(1);

  await service.respond('clarify_MATRIX0001', 'ship');
  await clarify;
});

test('structured submit terminates only the structured record; the clarification survives', async () => {
  const { service, structuredEvents } = harness();
  const structured = service.request(source, confirmRequest, { mode: 'background' });
  const clarify = service.askStructured(sessionId, { requestId: 'clarify_MATRIX0002', question: 'Which path?' });
  await untilClarifyPending(service);

  const claim = service.claim('interaction-1', 'web-1', fullCapabilities);
  expect(service.listPending()).toEqual([expect.objectContaining({ id: 'interaction-1', state: 'claimed' })]);
  service.submit('interaction-1', claim.leaseToken, { confirmed: true });

  expect(await structured).toEqual({ status: 'submitted', values: { confirmed: true } });
  expect(structuredEvents.at(-1)).toEqual({ type: 'removed', id: 'interaction-1', outcome: 'submitted' });
  expect(service.listPending()).toEqual([]);
  expect(service.pendingCount).toBe(1);

  expect(await service.respond('clarify_MATRIX0002', 'ship')).toMatchObject({ status: 'answered', answer: 'ship' });
  expect(await clarify).toMatchObject({ status: 'answered', answer: 'ship' });
  expect(service.pendingCount).toBe(0);
});

test('structured cancel fires a cancelled terminal outcome', async () => {
  const { service, structuredEvents } = harness();
  const structured = service.request(source, confirmRequest, { mode: 'background' });
  await Promise.resolve();
  const claim = service.claim('interaction-1', 'web-1', fullCapabilities);

  service.cancel('interaction-1', claim.leaseToken, 'close');
  expect(await structured).toEqual({ status: 'cancelled', reason: 'close' });
  expect(structuredEvents.at(-1)).toEqual({ type: 'removed', id: 'interaction-1', outcome: 'cancelled' });
  expect(service.listPending()).toEqual([]);
});

test('structured expiry sweep fires a timeout terminal outcome without disturbing a human-only clarification', async () => {
  const { service, structuredEvents, advance } = harness();
  const structured = service.request(source, confirmRequest, { mode: 'background' });
  const clarify = service.askStructured(sessionId, { requestId: 'clarify_MATRIX0003', question: 'Which path?' });
  await untilClarifyPending(service);

  advance(300_001);
  service.sweepExpired();

  expect(await structured).toEqual({ status: 'cancelled', reason: 'timeout' });
  expect(structuredEvents.at(-1)).toEqual({ type: 'removed', id: 'interaction-1', outcome: 'timeout' });
  expect(service.pendingCount).toBe(1);

  await service.respond('clarify_MATRIX0003', '');
  await clarify;
});
