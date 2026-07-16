import type {
  AgentObservationEvent,
  Event,
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

  test('returns unavailable for a non-monad member (e.g. external-agent)', () => {
    const store = createStore();
    try {
      const session = fixtureSession(store);
      const now = new Date().toISOString();
      store.insertSessionMember({
        sessionId: session.id,
        memberId: 'external-agent:codex',
        templateId: null,
        type: 'external-agent',
        data: { name: 'codex' },
        createdAt: now,
        updatedAt: now
      });
      const { handlers } = buildHarness(store);

      const frame = handlers.observeMemberUi({ sessionId: session.id, memberId: 'external-agent:codex' });
      expect(frame.state).toBe('unavailable');
    } finally {
      store.close();
    }
  });

  test('projects persisted history events for the monad member as neutral events, in order', () => {
    const store = createStore();
    try {
      const session = fixtureSession(store);
      insertMonadMember(store, session.id);
      store.appendEvents([
        fixtureEvent(session.id, { type: 'user.message', payload: { messageId: 'msg_100000000000', text: 'hi' } }),
        fixtureEvent(session.id, { type: 'agent.message', payload: { messageId: 'msg_200000000000', text: 'hello' } })
      ]);
      const { handlers } = buildHarness(store);

      const frame = handlers.observeMemberUi({ sessionId: session.id, memberId: 'monad' });
      expect(frame.state).toBe('history');
      expect(eventsOf(frame).map((e) => e.kind)).toEqual(['user-message', 'assistant-message']);
    } finally {
      store.close();
    }
  });

  test('excludes events bridged from a different (managed external-agent) member', () => {
    const store = createStore();
    try {
      const session = fixtureSession(store);
      insertMonadMember(store, session.id);
      store.appendEvents([
        fixtureEvent(session.id, { type: 'user.message', payload: { messageId: 'msg_100000000000', text: 'hi' } }),
        fixtureEvent(session.id, {
          type: 'agent.message',
          payload: { messageId: 'msg_200000000000', text: 'from codex', externalAgentSessionId: 'exa_abc000000000' }
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
      cache.append(
        fixtureEvent(session.id, {
          type: 'agent.token',
          payload: { messageId: 'msg_100000000000', delta: 'Hi', index: 0 }
        })
      );

      const frame = handlers.observeMemberUi({ sessionId: session.id, memberId: 'monad' });
      expect(frame.state).toBe('live');
      expect(eventsOf(frame)).toMatchObject([{ kind: 'assistant-message', streaming: true, text: 'Hi' }]);
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

      bus.publish(
        fixtureEvent(session.id, { type: 'user.message', payload: { messageId: 'msg_100000000000', text: 'hi' } })
      );
      expect(frames).toHaveLength(2);
      expect(frames[1]).toMatchObject({ state: 'live', events: [{ kind: 'user-message' }] });

      // An event belonging to another member never reaches this subscriber.
      bus.publish(
        fixtureEvent(session.id, {
          type: 'agent.message',
          payload: { messageId: 'msg_200000000000', text: 'other', externalAgentSessionId: 'exa_abc000000000' }
        })
      );
      expect(frames).toHaveLength(2);

      dispose();
      bus.publish(
        fixtureEvent(session.id, {
          type: 'user.message',
          payload: { messageId: 'msg_300000000000', text: 'after dispose' }
        })
      );
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

      bus.publish(
        fixtureEvent(session.id, { type: 'user.message', payload: { messageId: 'msg_100000000000', text: 'hi' } })
      );
      expect(frames).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
