import type { Event, MessageProducer, TranscriptTargetId } from '@monad/protocol';
import type { MessageRepo } from '#/agent/index.ts';

import { expect, test } from 'bun:test';
import { messageIdSchema, newId } from '@monad/protocol';

import { AgentLoop } from '#/agent/index.ts';
import { emitCommandTurn } from '#/handlers/commands/session-commands.ts';
import { EventBus } from '#/services/event-bus.ts';
import { createMessageIngress, messageIdempotencyKey } from '#/services/messages/ingress.ts';
import { createStore } from '#/store/db/index.ts';
import { buildMockModel } from '../fixtures/mock-model.ts';

const producer: MessageProducer = { kind: 'system', subsystem: 'message-ingress-test' };
const keys = {
  ingressBegin: newId('idem'),
  ingressDeliver: newId('idem'),
  ingressSettle: newId('idem'),
  invalidData: newId('idem'),
  lifecycleBegin: newId('idem'),
  lifecycleDeliver: newId('idem'),
  lifecycleFail: newId('idem'),
  lifecycleRemove: newId('idem'),
  lifecycleUpdate: newId('idem'),
  missingTarget: newId('idem'),
  publishFailure: newId('idem')
};

function ingress(targetExists: (id: TranscriptTargetId) => boolean = () => true) {
  const store = createStore();
  const bus = new EventBus();
  const fanout: Event[] = [];
  return {
    store,
    bus,
    fanout,
    service: createMessageIngress({
      store,
      bus,
      targetExists,
      fanout: (event) => {
        fanout.push(event);
      }
    })
  };
}

test('durable commands commit once and publish the canonical lifecycle event once', async () => {
  const { store, bus, fanout, service } = ingress();
  const target = newId('prj');
  const control: Event[] = [];
  const scoped: Event[] = [];
  bus.subscribeControl((event) => control.push(event));
  bus.subscribe(target, (event) => scoped.push(event));

  const delivered = await service.deliver({
    transcriptTargetId: target,
    idempotencyKey: keys.ingressDeliver,
    producer,
    role: 'user',
    type: 'text',
    text: 'hello'
  });
  expect(delivered).toEqual({
    id: delivered.id,
    sessionId: target,
    role: 'user',
    text: 'hello',
    type: 'text',
    stream: { status: 'settled' },
    active: true,
    createdAt: delivered.createdAt
  });
  expect(scoped).toHaveLength(1);
  const createdEvent = scoped[0];
  if (!createdEvent) throw new Error('expected a created event');
  expect(scoped).toEqual([
    {
      id: createdEvent.id,
      sessionId: target,
      type: 'session.message.created',
      actorAgentId: null,
      payload: { transcriptTargetId: target, producer, message: delivered, messageRevision: 1 },
      at: createdEvent.at
    }
  ]);
  expect(control).toEqual(scoped);
  expect(control[0]).toBe(scoped[0]);
  expect(fanout).toEqual(scoped);

  expect(
    await service.deliver({
      transcriptTargetId: target,
      idempotencyKey: keys.ingressDeliver,
      producer,
      role: 'user',
      type: 'text',
      text: 'hello'
    })
  ).toEqual(delivered);
  expect(scoped).toHaveLength(1);
  expect(store.getMessageRevision(target)).toBe(1);
  await expect(
    service.deliver({
      transcriptTargetId: target,
      idempotencyKey: keys.ingressDeliver,
      producer,
      role: 'user',
      type: 'text',
      text: 'different'
    })
  ).rejects.toThrow('idempotency key reused with a different command');
  store.close();
});

test('command turns persist two directives and fan out the same canonical events', async () => {
  const { store, bus, service } = ingress();
  const target = newId('ses');
  const scoped: Event[] = [];
  const inline: Event[] = [];
  bus.subscribe(target, (event) => scoped.push(event));

  const reply = await emitCommandTurn(
    service,
    (event) => {
      inline.push(event);
    },
    target,
    '/help',
    { message: 'Available commands' }
  );
  const messages = store.listMessages(target);
  const [echo] = messages;
  if (!echo) throw new Error('expected a command echo');

  expect(messages).toEqual([
    {
      id: echo.id,
      sessionId: target,
      role: 'user',
      text: '/help',
      type: 'directive',
      data: undefined,
      stream: { status: 'settled', source: undefined },
      active: true,
      createdAt: echo.createdAt,
      updatedAt: undefined
    },
    {
      id: reply.id,
      sessionId: target,
      role: 'assistant',
      text: 'Available commands',
      type: 'directive',
      data: undefined,
      stream: { status: 'settled', source: undefined },
      active: true,
      createdAt: reply.createdAt,
      updatedAt: undefined
    }
  ]);
  expect(scoped.map((event) => ({ type: event.type, payload: event.payload }))).toEqual([
    {
      type: 'session.message.created',
      payload: {
        transcriptTargetId: target,
        producer: { kind: 'system', subsystem: 'command' },
        message: {
          id: echo.id,
          sessionId: target,
          role: 'user',
          text: '/help',
          type: 'directive',
          stream: { status: 'settled' },
          active: true,
          createdAt: echo.createdAt
        },
        messageRevision: 1
      }
    },
    {
      type: 'session.message.created',
      payload: {
        transcriptTargetId: target,
        producer: { kind: 'system', subsystem: 'command' },
        message: reply,
        messageRevision: 2
      }
    }
  ]);
  expect(inline).toEqual(scoped);
  expect(inline[0]).toBe(scoped[0]);
  expect(inline[1]).toBe(scoped[1]);
  store.close();
});

test('agent loop reuses canonical generation events across the bus and inline fanout', async () => {
  const { store, bus, service } = ingress();
  const target = newId('ses');
  const scoped: Event[] = [];
  const control: Event[] = [];
  const inline: Event[] = [];
  bus.subscribe(target, (event) => scoped.push(event));
  bus.subscribeControl((event) => control.push(event));
  const repo: MessageRepo = {
    publishesCanonicalEvents: true,
    list: (sessionId) => store.listMessages(sessionId),
    append: async (message, options) => {
      await service.commit(
        {
          message: {
            id: messageIdSchema.parse(message.id),
            sessionId: message.sessionId,
            role: message.role,
            text: message.text,
            type: message.type ?? 'text',
            ...(message.data === undefined ? {} : { data: message.data }),
            stream: { status: message.role === 'user' ? 'settled' : 'complete' },
            active: true,
            createdAt: message.createdAt
          },
          idempotencyKey: messageIdempotencyKey('loop-test', 'append', message.id),
          producer
        },
        options
      );
    },
    open: async (message, options) => {
      await service.commit(
        {
          message: {
            id: messageIdSchema.parse(message.id),
            sessionId: message.sessionId,
            role: message.role,
            text: message.text,
            type: 'text',
            stream: {
              status: 'pending',
              source: { transcriptTargetId: message.sessionId, messageId: messageIdSchema.parse(message.id) }
            },
            active: true,
            createdAt: message.createdAt
          },
          idempotencyKey: messageIdempotencyKey('loop-test', 'open', message.id),
          producer
        },
        options
      );
    },
    appendDelta: (input, options) =>
      service.append(
        {
          transcriptTargetId: input.sessionId,
          messageId: messageIdSchema.parse(input.messageId),
          producer,
          channel: input.channel,
          index: input.index,
          delta: input.delta
        },
        options
      ),
    settle: async (message, status, options) => {
      if (!store.getMessage(message.sessionId, message.id)) return false;
      if (status === 'error') {
        await service.fail(
          {
            transcriptTargetId: message.sessionId,
            messageId: messageIdSchema.parse(message.id),
            idempotencyKey: messageIdempotencyKey('loop-test', 'fail', message.id),
            producer,
            error: { code: 'agent_error', message: message.text },
            type: message.type,
            data: message.data
          },
          options
        );
      } else {
        await service.settle(
          {
            transcriptTargetId: message.sessionId,
            messageId: messageIdSchema.parse(message.id),
            idempotencyKey: messageIdempotencyKey('loop-test', 'settle', message.id),
            producer,
            text: message.text,
            data: message.data
          },
          options
        );
      }
      return true;
    }
  };
  const loop = new AgentLoop({
    model: buildMockModel().text(['hel', 'lo']).build(),
    tools: [],
    messages: repo,
    defaultModel: 'mock',
    emit: () => {},
    messageFanout: (event) => {
      inline.push(event);
    }
  });

  await loop.runStream(target, 'hi');

  expect(scoped.map((event) => event.type)).toEqual([
    'session.message.created',
    'session.message.created',
    'session.message.delta.appended',
    'session.message.delta.appended',
    'session.message.completed'
  ]);
  expect(control.map((event) => event.type)).toEqual([
    'session.message.created',
    'session.message.created',
    'session.message.completed'
  ]);
  expect(inline).toEqual(scoped);
  expect(inline.every((event, index) => event === scoped[index])).toBe(true);
  store.close();
});

test('streaming commands publish ordered deltas and reuse one terminal event across planes', async () => {
  const { store, bus, service } = ingress();
  const target = newId('ses');
  const control: Event[] = [];
  const scoped: Event[] = [];
  const inline: Event[] = [];
  bus.subscribeControl((event) => control.push(event));
  bus.subscribe(target, (event) => scoped.push(event));

  const pending = await service.begin(
    {
      transcriptTargetId: target,
      idempotencyKey: keys.ingressBegin,
      producer,
      role: 'assistant',
      type: 'markdown',
      text: ''
    },
    {
      fanout: (event) => {
        inline.push(event);
      }
    }
  );
  await service.append(
    {
      transcriptTargetId: target,
      messageId: pending.id,
      producer,
      channel: 'answer',
      index: 0,
      delta: 'hel'
    },
    {
      fanout: (event) => {
        inline.push(event);
      }
    }
  );
  await service.append({
    transcriptTargetId: target,
    messageId: pending.id,
    producer,
    channel: 'answer',
    index: 1,
    delta: 'lo'
  });
  await expect(
    service.append({
      transcriptTargetId: target,
      messageId: pending.id,
      producer,
      channel: 'answer',
      index: 1,
      delta: 'duplicate'
    })
  ).rejects.toThrow('delta index must increase monotonically');
  expect(store.getMessageRevision(target)).toBe(1);

  const settled = await service.settle(
    {
      transcriptTargetId: target,
      messageId: pending.id,
      idempotencyKey: keys.ingressSettle,
      producer,
      text: 'hello'
    },
    {
      fanout: (event) => {
        inline.push(event);
      }
    }
  );
  expect(settled.stream).toEqual({ status: 'complete' });
  expect(store.getMessageRevision(target)).toBe(2);
  expect(scoped.map((event) => event.type)).toEqual([
    'session.message.created',
    'session.message.delta.appended',
    'session.message.delta.appended',
    'session.message.completed'
  ]);
  expect(control.map((event) => event.type)).toEqual(['session.message.created', 'session.message.completed']);
  const [scopedCreated, scopedDelta, , scopedCompleted] = scoped;
  if (!scopedCreated || !scopedDelta || !scopedCompleted) throw new Error('expected scoped lifecycle events');
  expect(control[1]).toBe(scopedCompleted);
  expect(inline).toEqual([scopedCreated, scopedDelta, scopedCompleted]);
  const [inlineCreated, inlineDelta, inlineCompleted] = inline;
  if (!inlineCreated || !inlineDelta || !inlineCompleted) throw new Error('expected inline lifecycle events');
  expect(inlineCreated).toBe(scopedCreated);
  expect(inlineDelta).toBe(scopedDelta);
  expect(inlineCompleted).toBe(scopedCompleted);
  expect(scoped[1]?.payload).toEqual({
    transcriptTargetId: target,
    messageId: pending.id,
    producer,
    channel: 'answer',
    index: 0,
    delta: 'hel'
  });
  store.close();
});

test('update, failure, and removal publish exact durable snapshots', async () => {
  const { store, bus, service } = ingress();
  const target = newId('ses');
  const events: Event[] = [];
  bus.subscribe(target, (event) => events.push(event));
  const delivered = await service.deliver({
    transcriptTargetId: target,
    idempotencyKey: keys.lifecycleDeliver,
    producer,
    role: 'assistant',
    type: 'text',
    text: 'draft'
  });
  const updated = await service.update({
    transcriptTargetId: target,
    messageId: delivered.id,
    idempotencyKey: keys.lifecycleUpdate,
    producer,
    updates: { text: 'edited' }
  });
  const pending = await service.begin({
    transcriptTargetId: target,
    idempotencyKey: keys.lifecycleBegin,
    producer,
    role: 'assistant',
    type: 'text',
    text: ''
  });
  const failed = await service.fail({
    transcriptTargetId: target,
    messageId: pending.id,
    idempotencyKey: keys.lifecycleFail,
    producer,
    error: { code: 'provider_error', message: 'boom' }
  });
  expect(failed).toEqual({
    ...pending,
    text: 'boom',
    stream: { status: 'error' },
    updatedAt: failed.updatedAt
  });
  await service.remove({
    transcriptTargetId: target,
    messageId: delivered.id,
    idempotencyKey: keys.lifecycleRemove,
    producer
  });

  expect(events.map((event) => ({ type: event.type, payload: event.payload }))).toEqual([
    {
      type: 'session.message.created',
      payload: { transcriptTargetId: target, producer, message: delivered, messageRevision: 1 }
    },
    {
      type: 'session.message.updated',
      payload: { transcriptTargetId: target, producer, message: updated, messageRevision: 2 }
    },
    {
      type: 'session.message.created',
      payload: { transcriptTargetId: target, producer, message: pending, messageRevision: 3 }
    },
    {
      type: 'session.message.failed',
      payload: { transcriptTargetId: target, producer, message: failed, messageRevision: 4 }
    },
    {
      type: 'session.message.deleted',
      payload: { transcriptTargetId: target, producer, messageId: delivered.id, messageRevision: 5 }
    }
  ]);
  store.close();
});

test('validation and publication failures never roll back a committed snapshot', async () => {
  const denied = ingress(() => false);
  await expect(
    denied.service.deliver({
      transcriptTargetId: newId('ses'),
      idempotencyKey: keys.missingTarget,
      producer,
      role: 'user',
      type: 'text',
      text: 'nope'
    })
  ).rejects.toThrow('transcript target not found');
  denied.store.close();

  const { store, bus, fanout, service } = ingress();
  const target = newId('ses');
  bus.subscribe(target, () => {
    throw new Error('subscriber failed');
  });
  await expect(
    service.deliver({
      transcriptTargetId: target,
      idempotencyKey: keys.publishFailure,
      producer,
      role: 'user',
      type: 'card',
      text: 'fallback',
      data: { title: 'Valid card' }
    })
  ).rejects.toThrow('subscriber failed');
  expect(fanout).toHaveLength(1);
  const committedMessages = store.listMessages(target);
  expect(committedMessages).toHaveLength(1);
  const committed = committedMessages[0];
  if (!committed) throw new Error('expected a committed message');
  expect(committed).toEqual({
    id: committed.id,
    sessionId: target,
    role: 'user',
    text: 'fallback',
    type: 'card',
    data: { title: 'Valid card' },
    stream: { status: 'settled' },
    active: true,
    createdAt: committed.createdAt
  });
  expect(store.listMessagesSnapshot(target)).toEqual({
    messages: [committed],
    messageRevision: 1
  });
  await expect(
    service.deliver({
      transcriptTargetId: target,
      idempotencyKey: keys.invalidData,
      producer,
      role: 'assistant',
      type: 'card',
      text: 'bad',
      data: { actions: [{ label: '', url: 'javascript:alert(1)' }] }
    })
  ).rejects.toThrow('invalid message data');
  expect(store.getMessageRevision(target)).toBe(1);
  store.close();

  const fanoutStore = createStore();
  const fanoutBus = new EventBus();
  const fanoutTarget = newId('ses');
  const fanoutIngress = createMessageIngress({
    store: fanoutStore,
    bus: fanoutBus,
    targetExists: () => true,
    fanout: () => {
      throw new Error('fanout failed');
    }
  });
  await expect(
    fanoutIngress.deliver({
      transcriptTargetId: fanoutTarget,
      idempotencyKey: newId('idem'),
      producer,
      role: 'user',
      type: 'text',
      text: 'committed before fanout'
    })
  ).rejects.toThrow('fanout failed');
  const fanoutMessage = fanoutStore.listMessages(fanoutTarget)[0];
  if (!fanoutMessage) throw new Error('expected a message committed before fanout');
  expect(fanoutStore.listMessagesSnapshot(fanoutTarget)).toEqual({
    messages: [
      {
        id: fanoutMessage.id,
        sessionId: fanoutTarget,
        role: 'user',
        text: 'committed before fanout',
        type: 'text',
        stream: { status: 'settled' },
        active: true,
        createdAt: fanoutMessage.createdAt
      }
    ],
    messageRevision: 1
  });
  fanoutStore.close();
});
