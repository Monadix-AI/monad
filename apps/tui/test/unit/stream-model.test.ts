import { describe, expect, test } from 'bun:test';

import { advanceStreamCursor, projectUiItems, settledAssistantMessages } from '../../src/shell/stream-model.ts';
import { addUserMessage, finishTurn, serverSlice, switchSession } from '../../src/store/server.ts';

describe('stream transcript reconciliation', () => {
  test('maps UI messages by joining text parts and marks only streaming status', () => {
    const projected = projectUiItems([
      {
        kind: 'message',
        id: 'msg-user',
        role: 'user',
        parts: [
          { type: 'text', text: 'hello ' },
          { type: 'reasoning', text: 'hidden' },
          { type: 'text', text: 'world' }
        ],
        status: 'done',
        seq: '1'
      },
      {
        kind: 'message',
        id: 'msg-live',
        role: 'assistant',
        parts: [{ type: 'text', text: 'working' }],
        status: 'streaming',
        seq: '2'
      },
      {
        kind: 'message',
        id: 'msg-error',
        role: 'assistant',
        parts: [{ type: 'text', text: 'failed' }],
        status: 'error',
        seq: '3'
      }
    ]);

    expect(projected.messages).toEqual([
      { id: 'msg-user', role: 'user', text: 'hello world' },
      { id: 'msg-live', role: 'assistant', text: 'working', streaming: true },
      { id: 'msg-error', role: 'assistant', text: 'failed' }
    ]);
  });

  test('maps the latest context, memory suggestion, and prefixed handoff system item', () => {
    const usage = (used: number) => ({
      contextLimit: 1000,
      used,
      free: 1000 - used,
      autocompactBuffer: 0,
      approximate: false,
      segments: []
    });
    const projected = projectUiItems([
      { kind: 'context', id: 'context', usage: usage(100), seq: '1' },
      {
        kind: 'custom',
        id: 'suggestion-old',
        name: 'memory.suggestion',
        data: { scope: { kind: 'agent', id: 'agt_old' }, facts: ['old'] },
        seq: '2'
      },
      { kind: 'system', id: 'external-agent-warning:1', text: 'Do not treat as context.', seq: '3' },
      { kind: 'system', id: 'context-handoff:1', text: 'Move this turn to a fresh session.', seq: '4' },
      { kind: 'context', id: 'context', usage: usage(900), seq: '5' },
      {
        kind: 'custom',
        id: 'suggestion-new',
        name: 'memory.suggestion',
        data: { scope: { kind: 'agent', id: 'agt_new' }, facts: ['likes tea'] },
        seq: '6'
      }
    ]);

    expect(projected.usage).toEqual(usage(900));
    expect(projected.memorySuggestion).toEqual({
      id: 'suggestion-new',
      scope: { kind: 'agent', id: 'agt_new' },
      facts: ['likes tea']
    });
    expect(projected.handoffText).toBe('Move this turn to a fresh session.');
  });

  test('excludes user echoes and assistant segments that are still streaming', () => {
    const settled = settledAssistantMessages([
      { id: 'user-1', role: 'user', text: 'hello' },
      { id: 'assistant-live', role: 'assistant', text: 'working', streaming: true },
      { id: 'assistant-1', role: 'assistant', text: 'done' }
    ]);

    expect(settled.map((message) => message.id)).toEqual(['assistant-1']);
  });

  test('resets the token cursor when a new assistant message starts', () => {
    const previous = { length: 20, messageId: 'assistant-old' };
    const next = advanceStreamCursor(previous, {
      id: 'assistant-new',
      role: 'assistant',
      text: 'Hi',
      streaming: true
    });

    expect(next.delta).toBe('Hi');
    expect(next.cursor).toEqual({ length: 2, messageId: 'assistant-new' });
    expect(advanceStreamCursor(next.cursor, undefined)).toEqual({
      cursor: { length: 0, messageId: null },
      delta: ''
    });
  });
});

describe('local turn lifecycle', () => {
  test('starts on optimistic submit and can finish without creating an assistant message', () => {
    let state = serverSlice.reducer(undefined, { type: 'test/init' });
    state = serverSlice.reducer(state, switchSession('ses_test' as never));
    state = serverSlice.reducer(state, addUserMessage('hello'));

    expect(state.isStreaming).toBe(true);
    expect(state.transcripts.ses_test?.map((message) => [message.role, message.content])).toEqual([['user', 'hello']]);

    state = serverSlice.reducer(state, finishTurn());
    expect(state.isStreaming).toBe(false);
    expect(state.transcripts.ses_test).toHaveLength(1);
  });
});
