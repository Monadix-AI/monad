import type { Event } from '@monad/protocol';

import { describe, expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { isMonadAgentDomainEvent, toAgentObservationEvent } from '#/agent/observation.ts';

function fixtureEvent(over: Partial<Event> & Pick<Event, 'type' | 'payload'>): Event {
  return {
    id: newId('evt'),
    sessionId: newId('ses'),
    actorAgentId: null,
    at: '2026-07-09T00:00:00.000Z',
    ...over
  };
}

describe('toAgentObservationEvent', () => {
  test('maps user.message to a neutral user-message event', () => {
    const event = fixtureEvent({ type: 'user.message', payload: { messageId: 'msg_100000000000', text: 'hi' } });
    expect(toAgentObservationEvent(event)).toMatchObject({
      id: event.id,
      kind: 'user-message',
      streaming: false,
      text: 'hi',
      at: event.at
    });
  });

  test('maps agent.token to a streaming assistant-message fragment', () => {
    const event = fixtureEvent({
      type: 'agent.token',
      payload: { messageId: 'msg_100000000000', delta: 'Hel', index: 0 }
    });
    expect(toAgentObservationEvent(event)).toMatchObject({
      kind: 'assistant-message',
      streaming: true,
      text: 'Hel'
    });
  });

  test('maps agent.reasoning to a streaming reasoning fragment', () => {
    const event = fixtureEvent({
      type: 'agent.reasoning',
      payload: { messageId: 'msg_100000000000', delta: 'thinking...', index: 0 }
    });
    expect(toAgentObservationEvent(event)).toMatchObject({ kind: 'reasoning', streaming: true, text: 'thinking...' });
  });

  test('maps agent.message to a settled assistant-message event', () => {
    const event = fixtureEvent({ type: 'agent.message', payload: { messageId: 'msg_100000000000', text: 'done' } });
    expect(toAgentObservationEvent(event)).toMatchObject({
      kind: 'assistant-message',
      streaming: false,
      text: 'done'
    });
  });

  test('maps agent.error to a turn-end event with reason error', () => {
    const event = fixtureEvent({ type: 'agent.error', payload: { message: 'boom' } });
    expect(toAgentObservationEvent(event)).toMatchObject({ kind: 'turn-end', reason: 'error', text: 'boom' });
  });

  test('maps tool.called to a tool-call event', () => {
    const event = fixtureEvent({
      type: 'tool.called',
      payload: { toolCallId: 'call_1', tool: 'file_read', input: { path: '/a' } }
    });
    expect(toAgentObservationEvent(event)).toMatchObject({
      kind: 'tool-call',
      streaming: false,
      tool: { name: 'file_read', input: { path: '/a' } }
    });
  });

  test('maps tool.progress to a streaming tool-result event', () => {
    const event = fixtureEvent({
      type: 'tool.progress',
      payload: { toolCallId: 'call_1', tool: 'process_start', output: 'partial' }
    });
    expect(toAgentObservationEvent(event)).toMatchObject({
      kind: 'tool-result',
      streaming: true,
      tool: { name: 'process_start', output: 'partial' }
    });
  });

  test('maps tool.result to a settled tool-result event, preferring displayResult', () => {
    const event = fixtureEvent({
      type: 'tool.result',
      payload: { toolCallId: 'call_1', tool: 'file_read', ok: true, result: 'raw', displayResult: 'pretty' }
    });
    expect(toAgentObservationEvent(event)).toMatchObject({
      kind: 'tool-result',
      streaming: false,
      tool: { name: 'file_read', output: 'pretty' }
    });
  });

  test('falls back to result when tool.result has no displayResult', () => {
    const event = fixtureEvent({
      type: 'tool.result',
      payload: { toolCallId: 'call_1', tool: 'file_read', ok: true, result: 'raw' }
    });
    expect(toAgentObservationEvent(event)).toMatchObject({ tool: { output: 'raw' } });
  });

  test('maps the publish-only session.stream_started marker to turn-start', () => {
    const event = fixtureEvent({ type: 'session.stream_started', payload: {} });
    expect(toAgentObservationEvent(event)).toMatchObject({ kind: 'turn-start', streaming: false });
  });

  test('maps the publish-only session.stream_ended marker to a completed turn-end', () => {
    const event = fixtureEvent({ type: 'session.stream_ended', payload: {} });
    expect(toAgentObservationEvent(event)).toMatchObject({ kind: 'turn-end', reason: 'completed' });
  });

  test('returns null for a domain event with no neutral representation', () => {
    const event = fixtureEvent({ type: 'context.usage', payload: {} });
    expect(toAgentObservationEvent(event)).toBeNull();
  });

  test('carries the domain event as its contract provenance', () => {
    const event = fixtureEvent({ type: 'user.message', payload: { messageId: 'msg_100000000000', text: 'hi' } });
    expect(toAgentObservationEvent(event)?.provenance.contractEvents).toEqual([event]);
  });
});

describe('isMonadAgentDomainEvent', () => {
  test('is true for an event with no externalAgentSessionId/deliveryId', () => {
    const event = fixtureEvent({ type: 'agent.message', payload: { messageId: 'msg_100000000000', text: 'hi' } });
    expect(isMonadAgentDomainEvent(event)).toBe(true);
  });

  test('is false for a managed external-agent member bridged into the same session log', () => {
    const event = fixtureEvent({
      type: 'agent.token',
      payload: { messageId: 'msg_100000000000', delta: 'x', index: 0, externalAgentSessionId: 'exa_abc000000000' }
    });
    expect(isMonadAgentDomainEvent(event)).toBe(false);
  });

  test('is false for an event tagged with a native-agent delivery id', () => {
    const event = fixtureEvent({
      type: 'agent.message',
      payload: { messageId: 'msg_100000000000', text: 'hi', deliveryId: 'ndl_abc' }
    });
    expect(isMonadAgentDomainEvent(event)).toBe(false);
  });
});
