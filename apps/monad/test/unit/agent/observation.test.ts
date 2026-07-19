import type { ChatMessage, Event } from '@monad/protocol';

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

function fixtureMessage(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'msg_100000000000',
    sessionId: 'ses_100000000000',
    role: 'assistant',
    text: '',
    type: 'text',
    stream: { status: 'settled' },
    active: true,
    createdAt: '2026-07-09T00:00:00.000Z',
    ...over
  };
}

describe('toAgentObservationEvent', () => {
  test('maps a settled user session.message.created to a neutral user-message event', () => {
    const event = fixtureEvent({
      type: 'session.message.created',
      payload: {
        transcriptTargetId: 'ses_100000000000',
        producer: { kind: 'user' },
        message: fixtureMessage({ role: 'user', text: 'hi' }),
        messageRevision: 1
      }
    });
    expect(toAgentObservationEvent(event)).toMatchObject({
      id: event.id,
      kind: 'user-message',
      streaming: false,
      text: 'hi',
      at: event.at
    });
  });

  test('returns null for a non-user session.message.created (agent messages surface via delta/completed)', () => {
    const event = fixtureEvent({
      type: 'session.message.created',
      payload: {
        transcriptTargetId: 'ses_100000000000',
        producer: { kind: 'agent', agentId: 'agt_100000000000' },
        message: fixtureMessage({ role: 'assistant', text: 'partial', stream: { status: 'streaming' } }),
        messageRevision: 1
      }
    });
    expect(toAgentObservationEvent(event)).toBeNull();
  });

  test('maps a content session.message.delta.appended to a streaming assistant-message fragment', () => {
    const event = fixtureEvent({
      type: 'session.message.delta.appended',
      payload: {
        transcriptTargetId: 'ses_100000000000',
        producer: { kind: 'agent', agentId: 'agt_100000000000' },
        messageId: 'msg_100000000000',
        channel: 'content',
        index: 0,
        delta: 'Hel'
      }
    });
    expect(toAgentObservationEvent(event)).toMatchObject({ kind: 'assistant-message', streaming: true, text: 'Hel' });
  });

  test('maps a reasoning session.message.delta.appended to a streaming reasoning fragment', () => {
    const event = fixtureEvent({
      type: 'session.message.delta.appended',
      payload: {
        transcriptTargetId: 'ses_100000000000',
        producer: { kind: 'agent', agentId: 'agt_100000000000' },
        messageId: 'msg_100000000000',
        channel: 'reasoning',
        index: 0,
        delta: 'thinking...'
      }
    });
    expect(toAgentObservationEvent(event)).toMatchObject({ kind: 'reasoning', streaming: true, text: 'thinking...' });
  });

  test('maps session.message.completed to a settled assistant-message event', () => {
    const event = fixtureEvent({
      type: 'session.message.completed',
      payload: {
        transcriptTargetId: 'ses_100000000000',
        producer: { kind: 'agent', agentId: 'agt_100000000000' },
        message: fixtureMessage({ role: 'assistant', text: 'done' }),
        messageRevision: 2
      }
    });
    expect(toAgentObservationEvent(event)).toMatchObject({ kind: 'assistant-message', streaming: false, text: 'done' });
  });

  test('maps session.message.failed to a turn-end event with reason error', () => {
    const event = fixtureEvent({
      type: 'session.message.failed',
      payload: {
        transcriptTargetId: 'ses_100000000000',
        producer: { kind: 'agent', agentId: 'agt_100000000000' },
        message: fixtureMessage({ role: 'assistant', text: 'boom' }),
        messageRevision: 2
      }
    });
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

  test('maps the publish-only session.run.started marker to turn-start', () => {
    const event = fixtureEvent({
      type: 'session.run.started',
      payload: { transcriptTargetId: 'ses_100000000000' }
    });
    expect(toAgentObservationEvent(event)).toMatchObject({ kind: 'turn-start', streaming: false });
  });

  test('maps the publish-only session.run.completed marker to a completed turn-end', () => {
    const event = fixtureEvent({
      type: 'session.run.completed',
      payload: { transcriptTargetId: 'ses_100000000000' }
    });
    expect(toAgentObservationEvent(event)).toMatchObject({ kind: 'turn-end', reason: 'completed' });
  });

  test('returns null for a domain event with no neutral representation', () => {
    const event = fixtureEvent({ type: 'context.usage', payload: {} });
    expect(toAgentObservationEvent(event)).toBeNull();
  });

  test('carries the domain event as its contract provenance', () => {
    const event = fixtureEvent({
      type: 'session.message.created',
      payload: {
        transcriptTargetId: 'ses_100000000000',
        producer: { kind: 'user' },
        message: fixtureMessage({ role: 'user', text: 'hi' }),
        messageRevision: 1
      }
    });
    expect(toAgentObservationEvent(event)?.provenance.contractEvents).toEqual([event]);
  });
});

describe('isMonadAgentDomainEvent', () => {
  function messageEvent(type: Event['type'], producer: unknown, extra: Record<string, unknown>): Event {
    return fixtureEvent({
      type,
      payload: { transcriptTargetId: 'ses_100000000000', producer, messageRevision: 1, ...extra }
    });
  }

  test('is true for a monad agent canonical message (agent producer, no external session)', () => {
    const event = messageEvent(
      'session.message.completed',
      { kind: 'agent', agentId: 'agt_100000000000' },
      {
        message: fixtureMessage({ role: 'assistant', text: 'hi' })
      }
    );
    expect(isMonadAgentDomainEvent(event)).toBe(true);
  });

  test('is true for a system producer', () => {
    const event = messageEvent(
      'session.message.created',
      { kind: 'system', subsystem: 'memory' },
      {
        message: fixtureMessage({ role: 'system', text: 'note' })
      }
    );
    expect(isMonadAgentDomainEvent(event)).toBe(true);
  });

  test('is false for an external-agent producer on a created message', () => {
    const event = messageEvent(
      'session.message.created',
      { kind: 'external-agent', externalAgentSessionId: 'exa_abc000000000' },
      {
        message: fixtureMessage({ role: 'assistant', text: 'x' })
      }
    );
    expect(isMonadAgentDomainEvent(event)).toBe(false);
  });

  test('is false for an external-agent producer on a completed message', () => {
    const event = messageEvent(
      'session.message.completed',
      { kind: 'external-agent', externalAgentSessionId: 'exa_abc000000000' },
      {
        message: fixtureMessage({ role: 'assistant', text: 'done' })
      }
    );
    expect(isMonadAgentDomainEvent(event)).toBe(false);
  });

  test('is false for an external-agent producer on a delta', () => {
    const event = messageEvent(
      'session.message.delta.appended',
      { kind: 'external-agent', externalAgentSessionId: 'exa_abc000000000' },
      {
        messageId: 'msg_100000000000',
        channel: 'content',
        index: 0,
        delta: 'x'
      }
    );
    expect(isMonadAgentDomainEvent(event)).toBe(false);
  });

  test('is false for an agent producer bound to an external-agent session', () => {
    const event = messageEvent(
      'session.message.completed',
      { kind: 'agent', agentId: 'agt_100000000000', externalAgentSessionId: 'exa_abc000000000' },
      { message: fixtureMessage({ role: 'assistant', text: 'x' }) }
    );
    expect(isMonadAgentDomainEvent(event)).toBe(false);
  });

  test('a non-message event falls back to the top-level bridge check', () => {
    const bridged = fixtureEvent({
      type: 'tool.result',
      payload: { toolCallId: 'c', tool: 't', ok: true, result: 'r', externalAgentSessionId: 'exa_abc000000000' }
    });
    expect(isMonadAgentDomainEvent(bridged)).toBe(false);
    const own = fixtureEvent({ type: 'tool.result', payload: { toolCallId: 'c', tool: 't', ok: true, result: 'r' } });
    expect(isMonadAgentDomainEvent(own)).toBe(true);
  });
});
