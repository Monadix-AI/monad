import type { Event, EventType, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { EventBus } from '@/services/event-bus.ts';

let counter = 0;
const ev = (type: EventType, sessionId: string): Event => ({
  id: `evt_${(counter++).toString().padStart(26, '0')}` as Event['id'],
  sessionId: sessionId as SessionId,
  type,
  actorAgentId: null,
  payload: { title: 't' },
  at: '2026-06-12T00:00:00.000Z' as Event['at']
});

test('control subscriber sees list-level events from sessions it never subscribed to', () => {
  const bus = new EventBus();
  const control: EventType[] = [];
  bus.subscribeControl((e) => control.push(e.type));

  bus.publish(ev('session.created', 'ses_brand_new'));
  bus.publish(ev('task.completed', 'ses_other'));

  expect(control).toEqual(['session.created', 'task.completed']);
});

test('external-agent lifecycle fans out to control so the session list stays live without a reload', () => {
  const bus = new EventBus();
  const control: EventType[] = [];
  bus.subscribeControl((e) => control.push(e.type));

  bus.publish(ev('external_agent.started', 'prj_a'));
  bus.publish(ev('external_agent.output', 'prj_a'));
  bus.publish(ev('external_agent.exited', 'prj_a'));

  // started/exited are list-level (a session appeared/ended); per-token output stays session-scoped.
  expect(control).toEqual(['external_agent.started', 'external_agent.exited']);
});

test('in-session detail does not fan out to the control stream', () => {
  const bus = new EventBus();
  const control: EventType[] = [];
  const session: EventType[] = [];
  bus.subscribeControl((e) => control.push(e.type));
  bus.subscribe('ses_a' as SessionId, (e) => session.push(e.type));

  bus.publish(ev('agent.token', 'ses_a'));
  bus.publish(ev('tool.called', 'ses_a'));
  bus.publish(ev('session.updated', 'ses_a'));

  // The session subscriber sees everything for its session...
  expect(session).toEqual(['agent.token', 'tool.called', 'session.updated']);
  // ...but control only ever carries the list-level slice.
  expect(control).toEqual(['session.updated']);
});

test('disposing a subscription stops delivery and frees the topic', () => {
  const bus = new EventBus();
  const seen: EventType[] = [];
  const dispose = bus.subscribe('ses_a' as SessionId, (e) => seen.push(e.type));

  bus.publish(ev('session.updated', 'ses_a'));
  dispose();
  bus.publish(ev('session.updated', 'ses_a'));

  expect(seen).toEqual(['session.updated']);
});
