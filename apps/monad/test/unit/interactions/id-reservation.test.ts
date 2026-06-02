// ID-level atomicity, restore-collision semantics, and the enable contract for the unified
// InteractionService. A clarify ask reserves its id synchronously (before the async question commit) so
// a concurrent same-id ask or a colliding structured createId() fails closed instead of overwriting the
// first waiter. Restore skips only a byte-identical replay; a structured or different-anchor collision
// fails closed and leaves the original record intact. Also covers pre-enable / double-enable.

import type {
  Event,
  InteractionPresenterCapabilities,
  InteractionProducer,
  InteractionRequest,
  TranscriptTargetId
} from '@monad/protocol';
import type { MessageIngress } from '#/services/messages/types.ts';

import { expect, test } from 'bun:test';
import { parseEventPayload } from '@monad/protocol';

import { InteractionService } from '#/interactions/service.ts';
import { EventBus } from '#/services/event-bus.ts';
import { createMessageIngress } from '#/services/messages/ingress.ts';
import { createStore } from '#/store/db/index.ts';

const sessionId = 'ses_TEST00000000' as TranscriptTargetId;
const source: InteractionProducer = { kind: 'atom-pack', packId: 'example.pack', atomId: 'configure' };
const confirmRequest: InteractionRequest = { type: 'confirm', title: 'Allow?' };
const fullCapabilities: InteractionPresenterCapabilities = {
  interactionTypes: ['confirm', 'select', 'form'],
  fieldTypes: ['string', 'secret', 'number', 'boolean', 'select'],
  supportsSecretInput: true,
  supportsBackgroundQueue: true
};

// A live, unresolved clarify.requested event captured from a source service — the raw durable record a
// restart would replay.
async function captureRequestedEvent(): Promise<{
  event: Event;
  ingress: MessageIngress;
  store: ReturnType<typeof createStore>;
  requestId: string;
}> {
  const store = createStore();
  const events: Event[] = [];
  const ingress = createMessageIngress({ store, bus: new EventBus(), targetExists: () => true });
  const service = new InteractionService({ clarify: { ingress, publish: (e) => events.push(e) } });
  void service.askStructured(sessionId, { question: 'Must a human decide?' });
  for (let attempt = 0; attempt < 20 && !events.some((e) => e.type === 'clarify.requested'); attempt += 1) {
    await Promise.resolve();
  }
  const event = events.find((e) => e.type === 'clarify.requested');
  if (!event) throw new Error('no clarify.requested event captured');
  return { event, ingress, store, requestId: firstRequestId(events) };
}

function deferredQuestionIngress(base: MessageIngress) {
  let questionAttempts = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const ingress: MessageIngress = {
    ...base,
    async deliver(command, options) {
      if (command.role === 'assistant' && command.type === 'clarify') {
        questionAttempts += 1;
        await gate;
      }
      return base.deliver(command, options);
    }
  };
  return { ingress, releaseQuestion: () => release?.(), questionAttempts: () => questionAttempts };
}

function firstRequestId(events: Event[]): string {
  const event = events.find((e) => e.type === 'clarify.requested');
  if (!event) throw new Error('no clarify.requested event');
  return parseEventPayload('clarify.requested', event.payload).requestId;
}

test('a concurrent ask with the same request id fails closed without overwriting the first or delivering twice', async () => {
  const store = createStore();
  const events: Event[] = [];
  const base = createMessageIngress({ store, bus: new EventBus(), targetExists: () => true });
  const { ingress, releaseQuestion, questionAttempts } = deferredQuestionIngress(base);
  const service = new InteractionService({ clarify: { ingress, publish: (e) => events.push(e) } });

  const first = service.askStructured(sessionId, { requestId: 'clarify_DUP00000001', question: 'q' });
  while (questionAttempts() === 0) await Promise.resolve();
  const secondOutcome = service.askStructured(sessionId, { requestId: 'clarify_DUP00000001', question: 'q' }).then(
    () => 'resolved',
    (error: unknown) => (error instanceof Error ? error.message : String(error))
  );
  for (let attempt = 0; attempt < 10; attempt += 1) await Promise.resolve();

  releaseQuestion();
  expect(await secondOutcome).toBe('clarification request already exists: clarify_DUP00000001');
  expect(questionAttempts()).toBe(1);

  for (let attempt = 0; attempt < 20 && service.pendingCount === 0; attempt += 1) await Promise.resolve();
  expect(await service.respond('clarify_DUP00000001', 'ok')).toMatchObject({ status: 'answered', answer: 'ok' });
  expect(await first).toEqual({
    requestId: 'clarify_DUP00000001',
    answer: 'ok',
    status: 'answered',
    answerMessageId: expect.any(String)
  });
  expect({ pendingCount: service.pendingCount, questions: store.listMessages(sessionId).map((m) => m.text) }).toEqual({
    pendingCount: 0,
    questions: ['q', 'ok']
  });
});

test('a structured request whose createId collides with an in-flight clarify id fails closed', async () => {
  const store = createStore();
  const events: Event[] = [];
  const base = createMessageIngress({ store, bus: new EventBus(), targetExists: () => true });
  const { ingress, releaseQuestion, questionAttempts } = deferredQuestionIngress(base);
  const service = new InteractionService({
    now: () => 0,
    createId: () => 'clarify_XKIND000001',
    createLeaseToken: () => 'lease-1',
    clarify: { ingress, publish: (e) => events.push(e) }
  });

  const clarify = service.askStructured(sessionId, { requestId: 'clarify_XKIND000001', question: 'q' });
  while (questionAttempts() === 0) await Promise.resolve();

  await expect(service.request(source, confirmRequest, { mode: 'background' })).rejects.toThrow(
    'Interaction id clarify_XKIND000001 is already in use'
  );

  releaseQuestion();
  for (let attempt = 0; attempt < 20 && !events.some((e) => e.type === 'clarify.requested'); attempt += 1) {
    await Promise.resolve();
  }
  const requestId = firstRequestId(events);
  expect(service.pendingCount).toBe(1);
  expect(await service.respond(requestId, 'done')).toMatchObject({ status: 'answered', answer: 'done' });
  await clarify;
  expect(service.pendingCount).toBe(0);
});

test('restoring the same durable event twice registers it once and stays resolvable (idempotent replay)', async () => {
  const { event, ingress, store, requestId } = await captureRequestedEvent();
  const restored = new InteractionService({
    clarify: {
      ingress,
      publish: () => {},
      lookupTerminal: (id) => store.getClarificationResolution(id),
      restore: [event, event]
    }
  });
  expect(restored.pendingCount).toBe(1);
  expect(await restored.respond(requestId, 'yes')).toMatchObject({ status: 'answered', answer: 'yes' });
  expect(restored.pendingCount).toBe(0);
});

test('a restore whose id is already an active structured interaction fails closed; the structured settles', async () => {
  const { event, ingress, requestId } = await captureRequestedEvent();
  const service = new InteractionService({ createId: () => requestId, createLeaseToken: () => 'lease-1' });
  const structured = service.request(source, confirmRequest, { mode: 'background' });

  expect(() => service.enableClarify({ ingress, publish: () => {}, restore: [event] })).toThrow(
    `clarify restore id collision: ${requestId} is already an active structured interaction`
  );

  const claim = service.claim(requestId, 'web-1', fullCapabilities);
  service.submit(requestId, claim.leaseToken, { confirmed: true });
  expect(await structured).toEqual({ status: 'submitted', values: { confirmed: true } });
});

test('a restore whose id collides with a different-anchor clarification fails closed; the original is untouched', async () => {
  const { event, ingress, store, requestId } = await captureRequestedEvent();
  const conflicting = {
    ...event,
    payload: { ...event.payload, questionMessageId: 'msg_DIFFERENT012' }
  } as Event;
  const service = new InteractionService();

  let thrown: unknown;
  try {
    service.enableClarify({
      ingress,
      publish: () => {},
      lookupTerminal: (id) => store.getClarificationResolution(id),
      restore: [event, conflicting]
    });
  } catch (error) {
    thrown = error;
  }
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  // Stable boot diagnostic: names the id, the conflict, and both anchors so no DB lookup is needed.
  expect(message).toContain(`clarify restore id collision: ${requestId}`);
  expect(message).toContain('different anchor');
  expect(message).toContain('question=msg_DIFFERENT012');
  expect(message).toContain(`question=${parseEventPayload('clarify.requested', event.payload).questionMessageId}`);

  // The first (real) record registered before the conflicting one was rejected — it is intact and resolvable.
  expect(service.pendingCount).toBe(1);
  expect(await service.respond(requestId, 'yes')).toMatchObject({ status: 'answered', answer: 'yes' });
});

test('clarify methods fail before enable and enableClarify refuses a second wiring', async () => {
  const store = createStore();
  const ingress = createMessageIngress({ store, bus: new EventBus(), targetExists: () => true });
  const service = new InteractionService();

  expect(service.clarifyEnabled).toBe(false);
  await expect(service.askStructured(sessionId, { question: 'q' })).rejects.toThrow(
    'clarify capability is not configured'
  );

  service.enableClarify({ ingress, publish: () => {} });
  expect(service.clarifyEnabled).toBe(true);
  expect(() => service.enableClarify({ ingress, publish: () => {} })).toThrow('clarify capability is already enabled');
});
