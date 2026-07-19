import type { Event, EventType, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { EventBus } from '#/services/event-bus.ts';

let counter = 0;
const ev = (type: EventType, sessionId: string): Event => ({
  id: `evt_${(counter++).toString().padStart(26, '0')}` as Event['id'],
  sessionId: sessionId as SessionId,
  type,
  actorAgentId: null,
  payload: { title: 't' },
  at: '2026-06-12T00:00:00.000Z' as Event['at']
});

const deltaEvent = (sessionId: string): Event => ({
  ...ev('session.message.delta.appended', sessionId),
  payload: {
    transcriptTargetId: sessionId,
    producer: { kind: 'agent', agentId: 'agt_100000000000' },
    messageId: 'msg_100000000000',
    channel: 'answer',
    index: 0,
    delta: 'x'
  }
});

test('control subscriber sees list-level events from sessions it never subscribed to', () => {
  const bus = new EventBus();
  const control: EventType[] = [];
  bus.subscribeControl((e) => control.push(e.type));

  bus.publish(ev('session.created', 'ses_brandnew0000'));
  bus.publish(ev('task.completed', 'ses_other0000000'));

  expect(control).toEqual(['session.created', 'task.completed']);
});

test('mesh-agent lifecycle fans out to control so the session list stays live without a reload', () => {
  const bus = new EventBus();
  const control: EventType[] = [];
  bus.subscribeControl((e) => control.push(e.type));

  bus.publish(ev('mesh.started', 'prj_a00000000000'));
  bus.publish(ev('mesh.turn_settled', 'prj_a00000000000'));
  bus.publish(ev('mesh.exited', 'prj_a00000000000'));

  // started/exited are list-level (a session appeared/ended); per-turn detail stays session-scoped.
  expect(control).toEqual(['mesh.started', 'mesh.exited']);
});

test('mesh-agent connection lifecycle reaches session and control subscribers as the same event', () => {
  const bus = new EventBus();
  const session: Event[] = [];
  const control: Event[] = [];
  const opened = ev('mesh.session.connection.opened', 'ses_connection0000');
  const closed = ev('mesh.session.connection.closed', 'ses_connection0000');
  bus.subscribe('ses_connection0000' as SessionId, (event) => session.push(event));
  bus.subscribeControl((event) => control.push(event));

  bus.publish(opened);
  bus.publish(closed);

  expect(session).toEqual([opened, closed]);
  expect(control).toEqual([opened, closed]);
  expect(control[0]).toBe(session[0]);
  expect(control[1]).toBe(session[1]);
});

test('in-session detail does not fan out to the control stream', () => {
  const bus = new EventBus();
  const control: EventType[] = [];
  const session: EventType[] = [];
  bus.subscribeControl((e) => control.push(e.type));
  bus.subscribe('ses_a00000000000' as SessionId, (e) => session.push(e.type));

  bus.publish(deltaEvent('ses_a00000000000'));
  bus.publish(ev('tool.called', 'ses_a00000000000'));
  bus.publish(ev('session.updated', 'ses_a00000000000'));

  // The session subscriber sees everything for its session...
  expect(session).toEqual(['session.message.delta.appended', 'tool.called', 'session.updated']);
  // ...but control only ever carries the list-level slice.
  expect(control).toEqual(['session.updated']);
});

test('disposing a subscription stops delivery and frees the topic', () => {
  const bus = new EventBus();
  const seen: EventType[] = [];
  const dispose = bus.subscribe('ses_a00000000000' as SessionId, (e) => seen.push(e.type));

  bus.publish(ev('session.updated', 'ses_a00000000000'));
  dispose();
  bus.publish(ev('session.updated', 'ses_a00000000000'));

  expect(seen).toEqual(['session.updated']);
});

test('generic runtime subscriber sees approval and lifecycle events across sessions', () => {
  const bus = new EventBus();
  const seen: EventType[] = [];
  const dispose = bus.subscribeAll((event) => seen.push(event.type));

  bus.publish(ev('tool.approval_requested', 'ses_a00000000000'));
  bus.publish(ev('session.run.completed', 'ses_b00000000000'));
  dispose();
  bus.publish(ev('session.updated', 'ses_c00000000000'));

  expect(seen).toEqual(['tool.approval_requested', 'session.run.completed']);
});
