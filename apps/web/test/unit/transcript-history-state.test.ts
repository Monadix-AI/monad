import type { SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  activateTranscriptHistory,
  createTranscriptHistoryState,
  updateTranscriptHistory
} from '../../src/hooks/transcript-history-state.ts';

const sessionId = (value: string) => value as SessionId;

test('transcript history clears synchronously when its session owner changes', () => {
  const oldSession = sessionId('ses_old');
  const nextSession = sessionId('ses_next');
  const loaded = updateTranscriptHistory(createTranscriptHistoryState(oldSession), oldSession, (state) => ({
    ...state,
    items: [{ id: 'msg_old', kind: 'message', parts: [], role: 'assistant', seq: '0001' }]
  }));

  const switched = activateTranscriptHistory(loaded, nextSession);
  expect(switched.sessionId).toBe(nextSession);
  expect(switched.items).toEqual([]);
  expect(switched.mode).toBe('live');
});

test('transcript history rejects a late response from the previous session', () => {
  const oldSession = sessionId('ses_old');
  const nextSession = sessionId('ses_next');
  const switched = activateTranscriptHistory(createTranscriptHistoryState(oldSession), nextSession);

  expect(
    updateTranscriptHistory(switched, oldSession, (state) => ({
      ...state,
      items: [{ id: 'msg_old', kind: 'message', parts: [], role: 'assistant', seq: '0001' }]
    }))
  ).toEqual(switched);
});
