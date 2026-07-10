import type { SessionId, UIItem } from '@monad/protocol';

export type TranscriptMode = 'live' | 'history';

export type TranscriptHistoryState = {
  items: UIItem[];
  mode: TranscriptMode;
  sessionId: SessionId | null;
};

export function createTranscriptHistoryState(sessionId: SessionId | null): TranscriptHistoryState {
  return { items: [], mode: 'live', sessionId };
}

export function activateTranscriptHistory(
  state: TranscriptHistoryState,
  sessionId: SessionId | null
): TranscriptHistoryState {
  return state.sessionId === sessionId ? state : createTranscriptHistoryState(sessionId);
}

export function updateTranscriptHistory(
  state: TranscriptHistoryState,
  sessionId: SessionId | null,
  update: (current: TranscriptHistoryState) => TranscriptHistoryState
): TranscriptHistoryState {
  return state.sessionId === sessionId ? update(state) : state;
}
