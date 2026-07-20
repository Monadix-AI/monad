import type {
  AgentObservationEvent,
  Event,
  MessageProducer,
  Session,
  SessionId,
  SessionMemberUiObservationFrame
} from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';

import { describe, expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { HandlerError } from '#/handlers/handler-error.ts';
import { createSessionMemberObservationHandlers } from '#/handlers/session/handlers/session-member-observation.ts';
import { EventBus } from '#/services/event-bus.ts';
import { RoundCache } from '#/services/round-cache.ts';
import { createStore } from '#/store/db/index.ts';

function fixtureSession(store: ReturnType<typeof createStore>, over: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  const session: Session = {
    id: newId('ses'),
    title: 'test',
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0
    },
    costUsd: 0,
    createdAt: now,
    updatedAt: now,
    ...over
  };
  store.insertSession(session);
  return session;
}

function fixtureEvent(sessionId: SessionId, over: Partial<Event> & Pick<Event, 'type' | 'payload'>): Event {
  return { id: newId('evt'), sessionId, actorAgentId: null, at: new Date().toISOString(), ...over };
}

function userMessageEvent(sessionId: SessionId, messageId: `msg_${string}`, text: string): Event {
  return fixtureEvent(sessionId, {
    type: 'session.message.created',
    payload: {
      transcriptTargetId: sessionId,
      producer: { kind: 'user' },
      message: {
        id: messageId,
        sessionId,
        role: 'user',
        text,
        type: 'text',
        stream: { status: 'settled' },
        active: true,
        createdAt: '2026-07-19T00:00:00.000Z'
      },
      messageRevision: 1
    }
  });
}

function assistantMessageEvent(
  sessionId: SessionId,
  messageId: `msg_${string}`,
  text: string,
  producer: MessageProducer = { kind: 'agent', agentId: 'agt_100000000000' }
): Event {
  return fixtureEvent(sessionId, {
    type: 'session.message.completed',
    payload: {
      transcriptTargetId: sessionId,
      producer,
      message: {
        id: messageId,
        sessionId,
        role: 'assistant',
        text,
        type: 'text',
        stream: { status: 'complete' },
        active: true,
        createdAt: '2026-07-19T00:00:00.000Z'
      },
      messageRevision: 2
    }
  });
}

function assistantDeltaEvent(sessionId: SessionId, messageId: `msg_${string}`, delta: string): Event {
  return fixtureEvent(sessionId, {
    type: 'session.message.delta.appended',
    payload: {
      transcriptTargetId: sessionId,
      producer: { kind: 'agent', agentId: 'agt_100000000000' },
      messageId,
      channel: 'answer',
      index: 0,
      delta
    }
  });
}

function buildHarness(store: ReturnType<typeof createStore>) {
  const bus = new EventBus();
  const cache = new RoundCache();
  const aborts = new Map<SessionId, AbortController>();
  const ctx = {
    deps: { store, bus, cache },
    aborts,
    requireSession: (id: SessionId) => {
      const session = store.getSession(id);
      if (!session) throw new HandlerError('invalid', `session not found: ${id}`);
      return session;
    }
  } as unknown as SessionContext;
  return { handlers: createSessionMemberObservationHandlers(ctx), bus, cache, aborts };
}

function insertMonadMember(store: ReturnType<typeof createStore>, sessionId: SessionId): void {
  const now = new Date().toISOString();
  store.insertSessionMember({
    sessionId,
    memberId: 'monad',
    templateId: null,
    type: 'monad',
    data: { name: 'monad' },
    createdAt: now,
    updatedAt: now
  });
}

function eventsOf(frame: SessionMemberUiObservationFrame): AgentObservationEvent[] {
  return frame.state === 'unavailable' ? [] : frame.events;
}

describe('observeMemberUi', () => {
  test('returns unavailable for an unknown member id', () => {
    const store = createStore();
    try {
      const session = fixtureSession(store);
      const { handlers } = buildHarness(store);

      const frame = handlers.observeMemberUi({ sessionId: session.id, memberId: 'nope' });
      expect(frame).toMatchObject({ state: 'unavailable', sessionId: session.id, memberId: 'nope' });
    } finally {
      store.close();
    }
  });

  test('returns unavailable for a non-monad member (e.g. mesh-agent)', () => {
    const store = createStore();
    try {
      const session = fixtureSession(store);
      const now = new Date().toISOString();
      store.insertSessionMember({
        sessionId: session.id,
        memberId: 'mesh-agent:codex',
        templateId: null,
        type: 'mesh-agent',
        data: { name: 'codex' },
        createdAt: now,
        updatedAt: now
      });
      const { handlers } = buildHarness(store);

      const frame = handlers.observeMemberUi({ sessionId: session.id, memberId: 'mesh-agent:codex' });
      expect(frame.state).toBe('unavailable');
    } finally {
      store.close();
    }
  });

  test('projects persisted events for the monad member as neutral events, in order', () => {
    const store = createStore();
    try {
      const session = fixtureSession(store);
      insertMonadMember(store, session.id);
      store.appendEvents([
        userMessageEvent(session.id, 'msg_100000000000', 'hi'),
        assistantMessageEvent(session.id, 'msg_200000000000', 'hello')
      ]);
      const { handlers } = buildHarness(store);

      const frame = handlers.observeMemberUi({ sessionId: session.id, memberId: 'monad' });
      expect(frame.state).toBe('events');
      expect(eventsOf(frame).map((e) => e.kind)).toEqual(['user-message', 'assistant-message']);
    } finally {
      store.close();
    }
  });

  test('excludes events bridged from a different (managed mesh-agent) member', () => {
    const store = createStore();
    try {
      const session = fixtureSession(store);
      insertMonadMember(store, session.id);
      store.appendEvents([
        userMessageEvent(session.id, 'msg_100000000000', 'hi'),
        assistantMessageEvent(session.id, 'msg_200000000000', 'from codex', {
          kind: 'mesh-agent',
          meshSessionId: 'mesh_abc000000000'
        })
      ]);
      const { handlers } = buildHarness(store);

      const frame = handlers.observeMemberUi({ sessionId: session.id, memberId: 'monad' });
      expect(eventsOf(frame)).toHaveLength(1);
      expect(eventsOf(frame)[0]).toMatchObject({ kind: 'user-message' });
    } finally {
      store.close();
    }
  });

  test('reports state "live" and includes the active round tail when a turn is in flight', () => {
    const store = createStore();
    try {
      const session = fixtureSession(store);
      insertMonadMember(store, session.id);
      const { handlers, cache, aborts } = buildHarness(store);

      aborts.set(session.id, new AbortController());
      cache.append(assistantDeltaEvent(session.id, 'msg_100000000000', 'Hi'));

      const frame = handlers.observeMemberUi({ sessionId: session.id, memberId: 'monad' });
      expect(frame).toMatchObject({ state: 'live', operation: 'replace' });
      expect(eventsOf(frame)).toMatchObject([{ kind: 'assistant-message', streaming: true, text: 'Hi' }]);
    } finally {
      store.close();
    }
  });

  test('cursors the persisted-event resume position and resumes only what came after it', () => {
    const store = createStore();
    try {
      const session = fixtureSession(store);
      insertMonadMember(store, session.id);
      const first = userMessageEvent(session.id, 'msg_100000000000', 'hi');
      const second = assistantMessageEvent(session.id, 'msg_200000000000', 'hello');
      store.appendEvents([first, second]);
      const { handlers } = buildHarness(store);

      const full = handlers.observeMemberUi({ sessionId: session.id, memberId: 'monad' });
      expect(full).toMatchObject({ cursor: second.id });

      const resumed = handlers.observeMemberUi({
        sessionId: session.id,
        memberId: 'monad',
        afterEventId: first.id
      });
      expect(resumed).toMatchObject({ state: 'events', operation: 'replace' });
      expect(eventsOf(resumed).map((e) => e.kind)).toEqual(['assistant-message']);
      expect(resumed).toMatchObject({ cursor: second.id });
    } finally {
      store.close();
    }
  });

  test('resuming from an un-persisted (active-round) cursor replays only the buffered tail after it', () => {
    const store = createStore();
    try {
      const session = fixtureSession(store);
      insertMonadMember(store, session.id);
      const { handlers, cache, aborts } = buildHarness(store);

      aborts.set(session.id, new AbortController());
      const delta1 = assistantDeltaEvent(session.id, 'msg_100000000000', 'Hi');
      const delta2 = assistantDeltaEvent(session.id, 'msg_100000000000', ' there');
      cache.append(delta1);
      cache.append(delta2);

      const resumed = handlers.observeMemberUi({ sessionId: session.id, memberId: 'monad', afterEventId: delta1.id });
      expect(resumed).toMatchObject({ state: 'live', operation: 'replace' });
      expect(eventsOf(resumed)).toMatchObject([{ text: ' there' }]);
      expect(resumed).toMatchObject({ cursor: delta2.id });
    } finally {
      store.close();
    }
  });

  test('a persisted cursor from before the active round replays the completed round plus the buffered tail', () => {
    const store = createStore();
    try {
      const session = fixtureSession(store);
      insertMonadMember(store, session.id);
      const missed = userMessageEvent(session.id, 'msg_000000000000', 'earlier');
      const settled = userMessageEvent(session.id, 'msg_100000000000', 'hi');
      store.appendEvents([missed, settled]);
      const { handlers, cache, aborts } = buildHarness(store);

      aborts.set(session.id, new AbortController());
      const delta = assistantDeltaEvent(session.id, 'msg_200000000000', 'Hi');
      cache.append(delta);

      const resumed = handlers.observeMemberUi({ sessionId: session.id, memberId: 'monad', afterEventId: missed.id });
      expect(resumed).toMatchObject({ state: 'live', operation: 'replace' });
      expect(eventsOf(resumed).map((e) => e.kind)).toEqual(['user-message', 'assistant-message']);
      expect(resumed).toMatchObject({ cursor: delta.id });
    } finally {
      store.close();
    }
  });

  test('an unrecognized cursor falls back to the buffered tail when a round is active', () => {
    const store = createStore();
    try {
      const session = fixtureSession(store);
      insertMonadMember(store, session.id);
      const settled = userMessageEvent(session.id, 'msg_100000000000', 'hi');
      store.appendEvents([settled]);
      const { handlers, cache, aborts } = buildHarness(store);

      aborts.set(session.id, new AbortController());
      const delta = assistantDeltaEvent(session.id, 'msg_200000000000', 'Hi');
      cache.append(delta);

      const resumed = handlers.observeMemberUi({
        sessionId: session.id,
        memberId: 'monad',
        afterEventId: 'evt_unknown0000'
      });
      expect(resumed).toMatchObject({ state: 'live', operation: 'replace' });
      expect(eventsOf(resumed).map((e) => e.kind)).toEqual(['assistant-message']);
      expect(resumed).toMatchObject({ cursor: delta.id });
    } finally {
      store.close();
    }
  });

  test('omits the cursor when the member has produced no events yet', () => {
    const store = createStore();
    try {
      const session = fixtureSession(store);
      insertMonadMember(store, session.id);
      const { handlers } = buildHarness(store);

      const frame = handlers.observeMemberUi({ sessionId: session.id, memberId: 'monad' });
      expect(frame).not.toHaveProperty('cursor');
    } finally {
      store.close();
    }
  });
});

describe('subscribeMemberUiObservation', () => {
  test('emits an initial frame then a live frame per matching bus event', () => {
    const store = createStore();
    try {
      const session = fixtureSession(store);
      insertMonadMember(store, session.id);
      const { handlers, bus } = buildHarness(store);

      const frames: unknown[] = [];
      const { dispose } = handlers.subscribeMemberUiObservation({ sessionId: session.id, memberId: 'monad' }, (frame) =>
        frames.push(frame)
      );
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ state: 'events', operation: 'replace', events: [] });

      bus.publish(userMessageEvent(session.id, 'msg_100000000000', 'hi'));
      expect(frames).toHaveLength(2);
      expect(frames[1]).toMatchObject({ state: 'live', operation: 'append', events: [{ kind: 'user-message' }] });

      // An event belonging to another member never reaches this subscriber.
      bus.publish(
        assistantMessageEvent(session.id, 'msg_200000000000', 'other', {
          kind: 'mesh-agent',
          meshSessionId: 'mesh_abc000000000'
        })
      );
      expect(frames).toHaveLength(2);

      dispose();
      bus.publish(userMessageEvent(session.id, 'msg_300000000000', 'after dispose'));
      expect(frames).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  test('emits a single unavailable frame and never subscribes for an unknown member', () => {
    const store = createStore();
    try {
      const session = fixtureSession(store);
      const { handlers, bus } = buildHarness(store);

      const frames: unknown[] = [];
      handlers.subscribeMemberUiObservation({ sessionId: session.id, memberId: 'nope' }, (frame) => frames.push(frame));
      expect(frames).toEqual([
        { state: 'unavailable', sessionId: session.id, memberId: 'nope', reason: expect.any(String) }
      ]);

      bus.publish(userMessageEvent(session.id, 'msg_100000000000', 'hi'));
      expect(frames).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
