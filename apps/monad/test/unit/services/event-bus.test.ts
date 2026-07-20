import type { Event, EventType, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { EventBus, makeEvent } from '#/services/event-bus.ts';

let counter = 0;
const ev = (type: EventType, sessionId: string): Event => {
  const target = sessionId as SessionId;
  const at = `2026-06-12T00:00:${(counter++).toString().padStart(2, '0')}.000Z`;
  switch (type) {
    case 'session.created':
      return makeEvent(target, type, { title: 't' }, { at });
    case 'session.updated':
      return makeEvent(target, type, { title: 't' }, { at });
    case 'session.run.completed':
      return makeEvent(target, type, { transcriptTargetId: target }, { at });
    case 'task.completed':
      return makeEvent(target, type, { taskId: 'task-1' }, { at });
    case 'tool.called':
      return makeEvent(target, type, { toolCallId: 'call-1', tool: 'read', input: {} }, { at });
    case 'tool.approval_requested':
      return makeEvent(target, type, { requestId: 'request-1', tool: 'write', input: {} }, { at });
    case 'mesh.started':
      return makeEvent(
        target,
        type,
        {
          meshSessionId: 'mesh_100000000000',
          agentName: 'reviewer',
          provider: 'codex',
          workingPath: '/tmp/project',
          pid: 42
        },
        { at }
      );
    case 'mesh.turn_settled':
      return makeEvent(target, type, { meshSessionId: 'mesh_100000000000' }, { at });
    case 'mesh.exited':
      return makeEvent(target, type, { meshSessionId: 'mesh_100000000000', exitCode: 0, state: 'exited' }, { at });
    case 'mesh.session.connection.opened':
      return makeEvent(
        target,
        type,
        { meshSessionId: 'mesh_100000000000', provider: 'codex', observationEpoch: 'epoch-1' },
        { at }
      );
    case 'mesh.session.connection.closed':
      return makeEvent(
        target,
        type,
        {
          meshSessionId: 'mesh_100000000000',
          provider: 'codex',
          observationEpoch: 'epoch-1',
          reason: 'disconnected'
        },
        { at }
      );
    default:
      throw new Error(`unsupported test event: ${type}`);
  }
};

const deltaEvent = (sessionId: string): Event =>
  makeEvent(sessionId as SessionId, 'session.message.delta.appended', {
    transcriptTargetId: sessionId,
    producer: { kind: 'agent', agentId: 'agt_100000000000' },
    messageId: 'msg_100000000000',
    channel: 'answer',
    index: 0,
    delta: 'x'
  });

test('makeEvent rejects an invalid payload before publication', () => {
  expect(() =>
    makeEvent('ses_100000000000' as SessionId, 'mesh.resume_failed', {
      agentName: 'reviewer',
      provider: 'claude-code',
      providerSessionRef: 'thread-42',
      message: 'resume failed',
      fallback: 'cold-start'
    } as never)
  ).toThrow('Invalid input: expected string, received undefined');
});

test('EventBus rejects an Event assertion that bypasses makeEvent', () => {
  const bus = new EventBus();
  const seen: Event[] = [];
  bus.subscribe('ses_100000000000' as SessionId, (event) => seen.push(event));
  const invalid = {
    id: 'evt_100000000000',
    sessionId: 'ses_100000000000',
    type: 'mesh.resume_failed',
    actorAgentId: null,
    payload: {
      agentName: 'reviewer',
      provider: 'claude-code',
      providerSessionRef: 'thread-42',
      message: 'resume failed',
      fallback: 'cold-start'
    },
    at: '2026-07-20T00:00:00.000Z'
  } as Event;

  expect(() => bus.publish(invalid)).toThrow('Invalid input: expected string, received undefined');
  expect(seen).toEqual([]);
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
  const opened = ev('mesh.session.connection.opened', 'ses_connect00000');
  const closed = ev('mesh.session.connection.closed', 'ses_connect00000');
  bus.subscribe('ses_connect00000' as SessionId, (event) => session.push(event));
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
