import type { Event, EventPayload, EventType, TranscriptTargetId } from '@monad/protocol';
import type { ClarifyAskRequest, ClarifyCapabilityOptions } from '#/interactions/service.ts';
import type { MessageIngress } from '#/services/messages/types.ts';

import { expect, test } from 'bun:test';
import { parseEventPayload } from '@monad/protocol';

import { createClarifyTool } from '#/capabilities/tools/registry/clarify.ts';
import { InteractionService } from '#/interactions/service.ts';
import { EventBus } from '#/services/event-bus.ts';
import { createMessageIngress } from '#/services/messages/ingress.ts';
import { createStore } from '#/store/db/index.ts';

const sessionId = 'ses_TEST00000000' as TranscriptTargetId;

// Clarify is now one kind of the unified interaction service; this oracle drives it through that
// service's clarify capability. The exhaustive behavior below is the FULLY-EQUAL contract the fold
// must preserve.
const makeClarify = (opts: ClarifyCapabilityOptions): InteractionService => new InteractionService({ clarify: opts });

function capture(opts?: {
  ingress?: MessageIngress;
  maxPending?: number;
  restore?: Event[];
  store?: ReturnType<typeof createStore>;
  timeoutMs?: number;
}) {
  const events: Event[] = [];
  const store = opts?.store ?? createStore();
  const ingress = opts?.ingress ?? createMessageIngress({ store, bus: new EventBus(), targetExists: () => true });
  const clarify = makeClarify({
    ingress,
    publish: (event) => events.push(event),
    maxPending: opts?.maxPending,
    restore: opts?.restore,
    timeoutMs: opts?.timeoutMs
  });
  return { events, clarify, ingress, store };
}

type TypedEvent<T extends EventType> = Omit<Event, 'payload' | 'type'> & { payload: EventPayload<T>; type: T };

function eventsOfType<T extends EventType>(events: Event[], type: T): TypedEvent<T>[] {
  return events
    .filter((event) => event.type === type)
    .map((event) => ({ ...event, type, payload: parseEventPayload(type, event.payload) }));
}

const requested = (events: Event[]) => eventsOfType(events, 'clarify.requested');
const resolved = (events: Event[]) => eventsOfType(events, 'clarify.resolved');

async function waitForRequest(events: Event[]) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const request = requested(events)[0];
    if (request?.type === 'clarify.requested') return request;
    await Bun.sleep(1);
  }
  throw new Error('clarification request was not emitted');
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error(message);
}

const responseCases: Array<{
  answer: string;
  messageText: string;
  name: string;
  request: ClarifyAskRequest;
}> = [
  {
    name: 'single-choice',
    request: { question: 'Pick a reviewer', options: ['Lily', 'Steve'], mode: 'single' as const },
    answer: 'Lily',
    messageText: 'Lily'
  },
  {
    name: 'multiple-choice',
    request: { question: 'Pick reviewers', options: ['Lily', 'Steve'], mode: 'multiple' as const },
    answer: '["Lily","Steve"]',
    messageText: 'Lily, Steve'
  },
  { name: 'free-text', request: { question: 'Who should review?' }, answer: 'Lily', messageText: 'Lily' }
];

test.each(responseCases)(
  'persists one canonical question and replying user answer for $name responses',
  async ({ request, answer, messageText }) => {
    const { clarify, events, store } = capture();
    const waiter = clarify.askStructured(sessionId, request);
    const requestEvent = await waitForRequest(events);
    const { requestId, questionMessageId } = requestEvent.payload;

    expect(await clarify.respond(requestId, answer)).toEqual({
      status: 'answered',
      answer,
      resolvedAt: expect.any(String)
    });
    const result = await waiter;
    expect(result).toEqual({ requestId, answer, status: 'answered', answerMessageId: expect.any(String) });
    expect(store.listMessages(sessionId)).toEqual([
      expect.objectContaining({
        id: questionMessageId,
        role: 'assistant',
        type: 'clarify',
        text: request.question,
        data: expect.objectContaining({ requestId, status: 'answered' })
      }),
      expect.objectContaining({
        id: result.answerMessageId,
        role: 'user',
        type: 'text',
        text: messageText,
        replyToMessageId: questionMessageId
      })
    ]);
    expect(resolved(events)).toEqual([
      expect.objectContaining({
        type: 'clarify.resolved',
        payload: {
          requestId,
          answer,
          status: 'answered',
          questionMessageId,
          answerMessageId: result.answerMessageId
        }
      })
    ]);
    expect(clarify.pendingCount).toBe(0);
  }
);

test('URL clarification accepts structured actions and preserves a public completion message', async () => {
  const { clarify, events, store } = capture();
  const waiter = clarify.askStructured(sessionId, {
    question: 'Complete authorization',
    urlElicitation: { url: 'https://example.com/authorize', origin: 'https://example.com' }
  });
  const request = await waitForRequest(events);

  const response = await clarify.respond(request.payload.requestId, undefined, 'complete');
  const result = await waiter;

  expect({
    response,
    result,
    messages: store.listMessages(sessionId).map((message) => ({ role: message.role, text: message.text })),
    resolved: resolved(events).map((event) => event.payload.answer)
  }).toEqual({
    response: { status: 'answered', answer: 'Completed', resolvedAt: expect.any(String) },
    result: {
      requestId: request.payload.requestId,
      answer: 'Completed',
      status: 'answered',
      answerMessageId: expect.any(String)
    },
    messages: [
      { role: 'assistant', text: 'Complete authorization' },
      { role: 'user', text: 'Completed' }
    ],
    resolved: ['Completed']
  });
});

test('URL clarification maps legacy text cancellation to the structured cancellation outcome', async () => {
  const { clarify, events } = capture();
  const waiter = clarify.askStructured(sessionId, {
    question: 'Complete authorization',
    urlElicitation: { url: 'https://example.com/authorize', origin: 'https://example.com' }
  });
  const request = await waitForRequest(events);

  const response = await clarify.respond(request.payload.requestId, 'cancel');

  expect({ response, result: await waiter }).toEqual({
    response: { status: 'cancelled', resolvedAt: expect.any(String) },
    result: { requestId: request.payload.requestId, answer: '', status: 'cancelled' }
  });
});

test('uses a caller-owned canonical question as the reply target without creating a duplicate', async () => {
  const { clarify, events, ingress, store } = capture();
  const question = await ingress.deliver({
    transcriptTargetId: sessionId,
    idempotencyKey: 'idem_CALLERQST001',
    producer: { kind: 'mesh-agent', meshSessionId: 'mesh_CALLER000000', agentName: 'Lily' },
    role: 'assistant',
    type: 'text',
    text: 'Which path?'
  });
  const waiter = clarify.askStructured(sessionId, {
    question: 'Which path?',
    questionMessage: { id: question.id, createdAt: question.createdAt }
  } as ClarifyAskRequest & { questionMessage: { id: typeof question.id; createdAt: string } });
  const request = await waitForRequest(events);

  await clarify.respond(request.payload.requestId, 'Ship');

  expect(await waiter).toEqual({
    requestId: request.payload.requestId,
    answer: 'Ship',
    status: 'answered',
    answerMessageId: expect.any(String)
  });
  expect(store.listMessages(sessionId)).toEqual([
    expect.objectContaining({ id: question.id, text: 'Which path?', type: 'text' }),
    expect.objectContaining({ role: 'user', text: 'Ship', replyToMessageId: question.id })
  ]);
  expect(request.payload.questionMessageId).toBe(question.id);
});

test('emits the request only after the canonical question commit', async () => {
  const calls: string[] = [];
  const base = capture();
  const ingress: MessageIngress = {
    ...base.ingress,
    async deliver(command, options) {
      calls.push('question-commit');
      return base.ingress.deliver(command, options);
    }
  };
  const events: Event[] = [];
  const clarify = makeClarify({
    ingress,
    publish: (event) => {
      calls.push(event.type);
      events.push(event);
    }
  });
  void clarify.askStructured(sessionId, { question: 'Which environment?' });
  const request = await waitForRequest(events);

  expect(calls).toEqual(['question-commit', 'clarify.requested']);
  expect(request.payload.questionMessageId).toMatch(/^msg_/);
});

test('askStructured emits selectable question metadata and resolves with the request id', async () => {
  const { events, clarify } = capture();
  const p = clarify.askStructured('ses_TEST00000000', {
    question: 'Pick reviewers',
    options: ['Lily', 'Steve'],
    mode: 'multiple',
    allowOther: true,
    asker: { id: 'pmem_codex_1', name: 'Codex reviewer' }
  });
  await waitForRequest(events);

  expect(requested(events)[0]?.payload).toMatchObject({
    question: 'Pick reviewers',
    options: ['Lily', 'Steve'],
    mode: 'multiple',
    allowOther: true,
    asker: { id: 'pmem_codex_1', name: 'Codex reviewer' }
  });
  const requestId = requested(events)[0]?.payload.requestId as string;

  expect(await clarify.respond(requestId, '["Lily"]')).toMatchObject({ status: 'answered', answer: '["Lily"]' });
  await expect(p).resolves.toEqual({
    requestId,
    answer: '["Lily"]',
    status: 'answered',
    answerMessageId: expect.any(String)
  });
  expect(resolved(events)[0]?.payload).toMatchObject({ requestId, answer: '["Lily"]' });
});

test('askStructured publishes a caller-owned multi-question card as one durable request', async () => {
  const { events, clarify } = capture();
  const promise = clarify.askStructured('ses_TEST00000000', {
    requestId: 'clarify_CARD000001',
    question: 'Pick one',
    questions: [
      { id: 'q1', question: 'Pick one', options: ['A', 'B'], mode: 'single', allowOther: true },
      { id: 'why', question: 'Why?', options: [], mode: 'single', allowOther: true }
    ],
    blocking: true,
    origin: { kind: 'managed-project', meshSessionId: 'mesh_CARD00000001', agentId: 'codex' }
  });
  await waitForRequest(events);

  expect(requested(events)[0]?.payload).toMatchObject({
    requestId: 'clarify_CARD000001',
    blocking: true,
    questions: [
      { id: 'q1', question: 'Pick one' },
      { id: 'why', question: 'Why?' }
    ]
  });
  await clarify.respond('clarify_CARD000001', JSON.stringify({ q1: 'A', why: 'Because' }));
  await expect(promise).resolves.toEqual({
    requestId: 'clarify_CARD000001',
    answer: JSON.stringify({ q1: 'A', why: 'Because' }),
    status: 'answered',
    answerMessageId: expect.any(String)
  });
  expect(resolved(events)[0]?.payload).toMatchObject({
    requestId: 'clarify_CARD000001',
    status: 'answered',
    answers: { q1: 'A', why: 'Because' }
  });
});

test('respond on an unknown or expired id returns not-found', async () => {
  const { clarify } = capture();
  expect(await clarify.respond('clarify_NOPE', 'hi')).toEqual({ status: 'not-found' });
});

test('reserves capacity before concurrent question commits', async () => {
  const base = capture();
  let releaseQuestionCommit: (() => void) | undefined;
  const questionCommitGate = new Promise<void>((resolve) => {
    releaseQuestionCommit = resolve;
  });
  let questionCommitAttempts = 0;
  const ingress: MessageIngress = {
    ...base.ingress,
    async deliver(command, options) {
      if (command.role === 'assistant' && command.type === 'clarify') {
        questionCommitAttempts += 1;
        await questionCommitGate;
      }
      return base.ingress.deliver(command, options);
    }
  };
  const { clarify, events, store } = capture({ ingress, maxPending: 1, store: base.store });
  const first = clarify.askStructured(sessionId, { question: 'q1' });
  await waitUntil(() => questionCommitAttempts > 0, 'question commit did not start');
  const secondOutcome = clarify.askStructured(sessionId, { question: 'q2' }).then(
    () => 'resolved',
    (error: unknown) => (error instanceof Error ? error.message : String(error))
  );
  for (let attempt = 0; attempt < 10; attempt += 1) await Promise.resolve();

  releaseQuestionCommit?.();
  expect(questionCommitAttempts).toBe(1);
  expect(await secondOutcome).toBe('pending clarification capacity exceeded');
  const request = await waitForRequest(events);
  expect({
    pendingCount: clarify.pendingCount,
    questions: store.listMessages(sessionId).map((message) => message.text)
  }).toEqual({
    pendingCount: 1,
    questions: ['q1']
  });
  await clarify.respond(request.payload.requestId, '');
  await first;
});

test('releases reserved capacity when the question commit fails', async () => {
  const base = capture();
  let rejectQuestion = true;
  const ingress: MessageIngress = {
    ...base.ingress,
    async deliver(command, options) {
      if (command.role === 'assistant' && rejectQuestion) throw new Error('question persistence failed');
      return base.ingress.deliver(command, options);
    }
  };
  const { clarify, events } = capture({ ingress, maxPending: 1, store: base.store });

  await expect(clarify.askStructured(sessionId, { question: 'q1' })).rejects.toThrow('question persistence failed');
  rejectQuestion = false;
  const retry = clarify.askStructured(sessionId, { question: 'q2' });
  const request = await waitForRequest(events);
  expect(clarify.pendingCount).toBe(1);
  await clarify.respond(request.payload.requestId, '');
  await retry;
});

test('computes expiry after the canonical question commit at the timer-arm point', async () => {
  const base = capture();
  let releaseQuestionCommit: (() => void) | undefined;
  const questionCommitGate = new Promise<void>((resolve) => {
    releaseQuestionCommit = resolve;
  });
  let questionCommitStarted = false;
  let questionCommittedAt = 0;
  const ingress: MessageIngress = {
    ...base.ingress,
    async deliver(command, options) {
      if (command.role === 'assistant' && command.type === 'clarify') {
        questionCommitStarted = true;
        await questionCommitGate;
      }
      const message = await base.ingress.deliver(command, options);
      if (command.role === 'assistant' && command.type === 'clarify') questionCommittedAt = Date.now();
      return message;
    }
  };
  const { clarify, events } = capture({ ingress, store: base.store });
  const waiter = clarify.askStructured(sessionId, { question: 'Still there?', autoResolutionMs: 60_000 });
  await waitUntil(() => questionCommitStarted, 'question commit did not start');
  await Bun.sleep(20);
  releaseQuestionCommit?.();
  const request = await waitForRequest(events);
  if (!request.payload.expiresAt) throw new Error('missing expiry');

  expect(Date.parse(request.payload.expiresAt)).toBeGreaterThanOrEqual(questionCommittedAt + 60_000);
  await clarify.respond(request.payload.requestId, '');
  await waiter;
});

test('timeout updates the canonical question without creating a user answer', async () => {
  const { clarify, events, store } = capture({ timeoutMs: 10 });
  const result = await clarify.askStructured(sessionId, { question: 'Still there?', autoResolutionMs: 60_000 });
  const request = requested(events)[0];
  if (request?.type !== 'clarify.requested') throw new Error('missing request');

  expect(result).toEqual({ requestId: request.payload.requestId, answer: '', status: 'timed-out' });
  expect(store.listMessages(sessionId)).toEqual([
    expect.objectContaining({
      id: request.payload.questionMessageId,
      role: 'assistant',
      type: 'clarify',
      data: expect.objectContaining({ status: 'timed-out' })
    })
  ]);
  expect(resolved(events)).toEqual([
    expect.objectContaining({
      payload: {
        requestId: request.payload.requestId,
        answer: '',
        status: 'timed_out',
        questionMessageId: request.payload.questionMessageId,
        reason: 'timeout'
      }
    })
  ]);
  expect(clarify.pendingCount).toBe(0);
});

test('automatic timeout retries a transient settlement failure without duplicating the terminal event', async () => {
  const base = capture();
  let updateAttempts = 0;
  const ingress: MessageIngress = {
    ...base.ingress,
    async update(command, options) {
      updateAttempts += 1;
      if (updateAttempts === 1) throw new Error('transient status update failure');
      return base.ingress.update(command, options);
    }
  };
  const { clarify, events, store } = capture({ ingress, store: base.store, timeoutMs: 5 });

  const result = await clarify.askStructured(sessionId, { question: 'Still there?', autoResolutionMs: 60_000 });
  const request = requested(events)[0];
  if (!request) throw new Error('missing request');

  expect({ result, updateAttempts, pendingCount: clarify.pendingCount }).toEqual({
    result: { requestId: request.payload.requestId, answer: '', status: 'timed-out' },
    updateAttempts: 2,
    pendingCount: 0
  });
  expect(store.listMessages(sessionId)).toEqual([
    expect.objectContaining({
      id: request.payload.questionMessageId,
      data: expect.objectContaining({ status: 'timed-out' })
    })
  ]);
  expect(resolved(events).map((event) => event.payload)).toEqual([
    {
      requestId: request.payload.requestId,
      answer: '',
      status: 'timed_out',
      questionMessageId: request.payload.questionMessageId,
      reason: 'timeout'
    }
  ]);
});

test('automatic timeout reports terminal settlement failure after bounded retries instead of leaking pending state', async () => {
  const base = capture();
  let updateAttempts = 0;
  const ingress: MessageIngress = {
    ...base.ingress,
    async update() {
      updateAttempts += 1;
      throw new Error('persistent status update failure');
    }
  };
  const { clarify, events } = capture({ ingress, store: base.store, timeoutMs: 5 });

  const result = await clarify.askStructured(sessionId, { question: 'Still there?', autoResolutionMs: 60_000 });
  const request = requested(events)[0];
  if (!request) throw new Error('missing request');

  expect({ result, updateAttempts, pendingCount: clarify.pendingCount }).toEqual({
    result: { requestId: request.payload.requestId, answer: '', status: 'cancelled' },
    updateAttempts: 3,
    pendingCount: 0
  });
  expect(resolved(events).map((event) => event.payload)).toEqual([
    {
      requestId: request.payload.requestId,
      answer: '',
      questionMessageId: request.payload.questionMessageId,
      reason: 'settlement_failed'
    }
  ]);
});

test('empty response cancels without creating a user answer', async () => {
  const { clarify, events, store } = capture();
  const waiter = clarify.askStructured(sessionId, { question: 'Proceed?' });
  const request = await waitForRequest(events);

  expect(await clarify.respond(request.payload.requestId, '')).toEqual({
    status: 'cancelled',
    resolvedAt: expect.any(String)
  });
  await expect(waiter).resolves.toEqual({ requestId: request.payload.requestId, answer: '', status: 'cancelled' });
  expect(store.listMessages(sessionId)).toEqual([
    expect.objectContaining({
      id: request.payload.questionMessageId,
      data: expect.objectContaining({ status: 'cancelled' })
    })
  ]);
});

test('transport abort does not cancel a required human question', async () => {
  const { clarify, events } = capture();
  const controller = new AbortController();
  const waiter = clarify.askStructured(sessionId, { question: 'Pick one?' }, { signal: controller.signal });
  const request = await waitForRequest(events);

  controller.abort();
  expect(clarify.pendingCount).toBe(1);
  expect(await clarify.respond(request.payload.requestId, 'late')).toMatchObject({
    status: 'answered',
    answer: 'late'
  });
  await expect(waiter).resolves.toEqual({
    requestId: request.payload.requestId,
    answer: 'late',
    status: 'answered',
    answerMessageId: expect.any(String)
  });
});

test('failed answer persistence leaves the waiter unresolved and the request actionable', async () => {
  const base = capture();
  let rejectAnswer = true;
  const ingress: MessageIngress = {
    ...base.ingress,
    async deliver(command, options) {
      if (command.role === 'user' && rejectAnswer) throw new Error('answer persistence failed');
      return base.ingress.deliver(command, options);
    }
  };
  const { clarify, events, store } = capture({ ingress, store: base.store });
  let waiterResolved = false;
  const waiter = clarify.askStructured(sessionId, { question: 'Choose?' }).then((result) => {
    waiterResolved = true;
    return result;
  });
  const request = await waitForRequest(events);

  await expect(clarify.respond(request.payload.requestId, 'Lily')).rejects.toThrow('answer persistence failed');
  await Promise.resolve();
  expect({ pendingCount: clarify.pendingCount, waiterResolved, messages: store.listMessages(sessionId) }).toEqual({
    pendingCount: 1,
    waiterResolved: false,
    messages: [expect.objectContaining({ id: request.payload.questionMessageId, role: 'assistant' })]
  });

  rejectAnswer = false;
  expect(await clarify.respond(request.payload.requestId, 'Lily')).toMatchObject({ status: 'answered' });
  await expect(waiter).resolves.toEqual({
    requestId: request.payload.requestId,
    answer: 'Lily',
    status: 'answered',
    answerMessageId: expect.any(String)
  });
});

test('resolved event publication failure keeps the waiter pending and retryable without duplicate answers', async () => {
  const base = capture();
  const events: Event[] = [];
  let rejectResolved = true;
  const clarify = makeClarify({
    ingress: base.ingress,
    publish: (event) => {
      if (event.type === 'clarify.resolved' && rejectResolved) throw new Error('resolved persistence failed');
      events.push(event);
    }
  });
  let waiterResolved = false;
  const waiter = clarify.askStructured(sessionId, { question: 'Choose?' }).then((result) => {
    waiterResolved = true;
    return result;
  });
  const request = await waitForRequest(events);

  await expect(clarify.respond(request.payload.requestId, 'Lily')).rejects.toThrow('resolved persistence failed');
  await Promise.resolve();
  const messagesAfterFailure = base.store.listMessages(sessionId);
  expect({ pendingCount: clarify.pendingCount, waiterResolved, messages: messagesAfterFailure }).toEqual({
    pendingCount: 1,
    waiterResolved: false,
    messages: [
      expect.objectContaining({
        id: request.payload.questionMessageId,
        data: expect.objectContaining({ status: 'answered' })
      }),
      expect.objectContaining({
        role: 'user',
        text: 'Lily',
        replyToMessageId: request.payload.questionMessageId
      })
    ]
  });
  expect(resolved(events)).toEqual([]);

  rejectResolved = false;
  expect(await clarify.respond(request.payload.requestId, 'Lily')).toMatchObject({ status: 'answered' });
  const result = await waiter;
  expect(base.store.listMessages(sessionId)).toEqual(messagesAfterFailure);
  const persistedAnswerId = messagesAfterFailure[1]?.id;
  if (!persistedAnswerId) throw new Error('canonical answer message was not persisted');
  expect(result).toEqual({
    requestId: request.payload.requestId,
    answer: 'Lily',
    status: 'answered',
    answerMessageId: persistedAnswerId
  });
});

test('retry reconciles a pending waiter after the resolved event was durably appended before publish failed', async () => {
  const store = createStore();
  const ingress = createMessageIngress({ store, bus: new EventBus(), targetExists: () => true });
  const events: Event[] = [];
  let rejectAfterResolvedAppend = true;
  let resolvedPublishAttempts = 0;
  const clarify = makeClarify({
    ingress,
    lookupTerminal: (requestId) => store.getClarificationResolution(requestId),
    publish: (event) => {
      store.appendEvents([event]);
      events.push(event);
      if (event.type === 'clarify.resolved') {
        resolvedPublishAttempts += 1;
        if (rejectAfterResolvedAppend) throw new Error('resolved listener failed after append');
      }
    }
  });
  let waiterResolved = false;
  const waiter = clarify.askStructured(sessionId, { question: 'Choose?' }).then((result) => {
    waiterResolved = true;
    return result;
  });
  const request = await waitForRequest(events);

  await expect(clarify.respond(request.payload.requestId, 'Lily')).rejects.toThrow(
    'resolved listener failed after append'
  );
  await Promise.resolve();
  const messagesAfterFailure = store.listMessages(sessionId);
  const durableTerminal = store.getClarificationResolution(request.payload.requestId);
  if (!durableTerminal) throw new Error('durable clarification terminal was not persisted');
  const persistedAnswerId = messagesAfterFailure[1]?.id;
  if (!persistedAnswerId) throw new Error('canonical answer message was not persisted');
  expect({ durableTerminal, pendingCount: clarify.pendingCount, waiterResolved }).toEqual({
    durableTerminal: { status: 'answered', answer: 'Lily', resolvedAt: expect.any(String) },
    pendingCount: 1,
    waiterResolved: false
  });

  rejectAfterResolvedAppend = false;
  expect(await clarify.respond(request.payload.requestId, 'ignored retry answer')).toEqual(durableTerminal);
  expect(await waiter).toEqual({
    requestId: request.payload.requestId,
    answer: 'Lily',
    status: 'answered',
    answerMessageId: persistedAnswerId
  });
  expect({ messages: store.listMessages(sessionId), pendingCount: clarify.pendingCount }).toEqual({
    messages: messagesAfterFailure,
    pendingCount: 0
  });
  expect({ resolvedPublishAttempts, durableResolvedEvents: resolved(store.listEvents(sessionId)) }).toEqual({
    resolvedPublishAttempts: 1,
    durableResolvedEvents: [
      expect.objectContaining({
        payload: expect.objectContaining({ requestId: request.payload.requestId, answer: 'Lily' })
      })
    ]
  });

  const replay = makeClarify({
    ingress,
    lookupTerminal: (requestId) => store.getClarificationResolution(requestId),
    publish: () => {
      throw new Error('terminal replay must not publish');
    }
  });
  expect(await replay.respond(request.payload.requestId, 'ignored replay answer')).toEqual(durableTerminal);
  expect(replay.pendingCount).toBe(0);
  expect(store.listMessages(sessionId)).toEqual(messagesAfterFailure);
});

test('durable terminal recovery continues a restored clarification exactly once', async () => {
  const source = capture();
  void source.clarify.askStructured(sessionId, { question: 'Must a human decide?' });
  const request = await waitForRequest(source.events);
  let rejectAfterResolvedAppend = true;
  let resolvedPublishAttempts = 0;
  const restored = makeClarify({
    ingress: source.ingress,
    restore: [request],
    lookupTerminal: (requestId) => source.store.getClarificationResolution(requestId),
    publish: (event) => {
      source.store.appendEvents([event]);
      if (event.type === 'clarify.resolved') {
        resolvedPublishAttempts += 1;
        if (rejectAfterResolvedAppend) throw new Error('resolved listener failed after append');
      }
    }
  });
  const continuations: Array<{ requestId: string; answer: string; answerMessageId: string }> = [];
  restored.setRecoveredContinuation(async ({ requestId, answer, answerMessageId }) => {
    continuations.push({ requestId, answer, answerMessageId });
  });

  await expect(restored.respond(request.payload.requestId, 'yes')).rejects.toThrow(
    'resolved listener failed after append'
  );
  const messagesAfterFailure = source.store.listMessages(sessionId);
  expect({ pendingCount: restored.pendingCount, continuations }).toEqual({ pendingCount: 1, continuations: [] });

  rejectAfterResolvedAppend = false;
  const durableTerminal = source.store.getClarificationResolution(request.payload.requestId);
  if (!durableTerminal) throw new Error('durable clarification terminal was not persisted');
  const persistedAnswerId = messagesAfterFailure[1]?.id;
  if (!persistedAnswerId) throw new Error('canonical answer message was not persisted');
  expect(await restored.respond(request.payload.requestId, 'ignored retry answer')).toEqual(durableTerminal);
  await Promise.resolve();
  expect({ pendingCount: restored.pendingCount, resolvedPublishAttempts, continuations }).toEqual({
    pendingCount: 0,
    resolvedPublishAttempts: 1,
    continuations: [
      {
        requestId: request.payload.requestId,
        answer: 'yes',
        answerMessageId: persistedAnswerId
      }
    ]
  });

  expect(await restored.respond(request.payload.requestId, 'ignored second retry')).toEqual(durableTerminal);
  await Promise.resolve();
  expect(continuations).toHaveLength(1);
  expect(source.store.listMessages(sessionId)).toEqual(messagesAfterFailure);
});

test('concurrent responses share one in-flight canonical settlement', async () => {
  const { clarify, events, store } = capture();
  const waiter = clarify.askStructured(sessionId, { question: 'Choose?' });
  const request = await waitForRequest(events);

  const [first, second] = await Promise.all([
    clarify.respond(request.payload.requestId, 'Lily'),
    clarify.respond(request.payload.requestId, 'Steve')
  ]);
  expect(second).toEqual(first);
  expect(store.listMessages(sessionId).map((message) => message.text)).toEqual(['Choose?', 'Lily']);
  await waiter;
});

test('restores the canonical question id and continues from its committed replying answer', async () => {
  const source = capture();
  void source.clarify.askStructured(sessionId, { question: 'Must a human decide?' });
  const request = await waitForRequest(source.events);

  const restored = capture({ restore: [request], store: source.store });
  const continuations: Array<{ requestId: string; answer: string; answerMessageId: string }> = [];
  restored.clarify.setRecoveredContinuation(async ({ requestId, answer, answerMessageId }) => {
    continuations.push({ requestId, answer, answerMessageId });
  });
  expect(restored.clarify.pendingCount).toBe(1);

  expect(await restored.clarify.respond(request.payload.requestId, 'yes')).toMatchObject({
    status: 'answered',
    answer: 'yes'
  });
  await Promise.resolve();
  const messages = source.store.listMessages(sessionId);
  const persistedAnswerId = messages[1]?.id;
  if (!persistedAnswerId) throw new Error('canonical answer message was not persisted');
  expect(messages).toEqual([
    expect.objectContaining({ id: request.payload.questionMessageId, role: 'assistant', type: 'clarify' }),
    expect.objectContaining({ role: 'user', text: 'yes', replyToMessageId: request.payload.questionMessageId })
  ]);
  expect(continuations).toEqual([
    {
      requestId: request.payload.requestId,
      answer: 'yes',
      answerMessageId: persistedAnswerId
    }
  ]);
});

test('clarify tool returns only the canonical answer pointer', async () => {
  const { events, clarify } = capture();
  const tool = createClarifyTool(clarify.ask);
  const pendingTool = tool.run({ question: 'Overwrite or merge?' }, { sessionId, log: () => {} });
  const request = await waitForRequest(events);

  await clarify.respond(request.payload.requestId, 'merge');
  expect((await pendingTool).metadata).toEqual({ answerMessageId: expect.stringMatching(/^msg_/) });
});

test('clarify tool rejects an empty question', () => {
  const tool = createClarifyTool(async () => ({ requestId: 'clarify_1', answer: '', status: 'cancelled' }));
  const parsed = tool.inputSchema?.safeParse({ question: '' });
  expect(parsed?.success).toBe(false);
});

test('clarify tool rejects non-string options', () => {
  const tool = createClarifyTool(async () => ({ requestId: 'clarify_1', answer: '', status: 'cancelled' }));
  const parsed = tool.inputSchema?.safeParse({ question: 'q', options: [1, 2] });
  expect(parsed?.success).toBe(false);
});

test('clarify tool accepts omitted auto-resolution and enforces the bounded window', () => {
  const tool = createClarifyTool(async () => ({ requestId: 'clarify_1', answer: '', status: 'cancelled' }));
  expect(tool.inputSchema?.safeParse({ question: 'required' }).success).toBe(true);
  expect(tool.inputSchema?.safeParse({ question: 'optional', autoResolutionMs: 60_000 }).success).toBe(true);
  expect(tool.inputSchema?.safeParse({ question: 'too soon', autoResolutionMs: 59_999 }).success).toBe(false);
  expect(tool.inputSchema?.safeParse({ question: 'too late', autoResolutionMs: 240_001 }).success).toBe(false);
});
