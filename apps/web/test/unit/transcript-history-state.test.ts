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
  const loaded = updateTranscriptHistory(createTranscriptHistoryState(oldSession), oldSession, 0, (state) => ({
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
    updateTranscriptHistory(switched, oldSession, 0, (state) => ({
      ...state,
      items: [{ id: 'msg_old', kind: 'message', parts: [], role: 'assistant', seq: '0001' }]
    }))
  ).toEqual(switched);
});

test('transcript history resets when the authoritative transcript revision changes', () => {
  const currentSession = sessionId('ses_current');
  const loaded = updateTranscriptHistory(
    createTranscriptHistoryState(currentSession, 0),
    currentSession,
    0,
    (state) => ({
      ...state,
      items: [{ id: 'msg_old', kind: 'message', parts: [], role: 'assistant', seq: '0001' }],
      mode: 'history'
    })
  );

  const replaced = activateTranscriptHistory(loaded, currentSession, 1);
  expect(replaced.items).toEqual([]);
  expect(replaced.mode).toBe('live');
  expect(replaced.replacementRevision).toBe(1);
});

test('transcript history rejects a late response from the previous replacement revision', () => {
  const currentSession = sessionId('ses_current');
  const replaced = activateTranscriptHistory(createTranscriptHistoryState(currentSession, 0), currentSession, 1);

  expect(
    updateTranscriptHistory(replaced, currentSession, 0, (state) => ({
      ...state,
      items: [{ id: 'msg_stale', kind: 'message', parts: [], role: 'assistant', seq: '0001' }]
    }))
  ).toEqual(replaced);
});
