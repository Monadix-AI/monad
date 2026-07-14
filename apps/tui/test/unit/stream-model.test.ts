import { describe, expect, test } from 'bun:test';

import { advanceStreamCursor, settledAssistantMessages } from '../../src/shell/stream-model.ts';
import { addUserMessage, finishTurn, serverSlice, switchSession } from '../../src/store/server.ts';

describe('stream transcript reconciliation', () => {
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
