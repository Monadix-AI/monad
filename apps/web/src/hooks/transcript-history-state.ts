import type { SessionId, UIItem } from '@monad/protocol';

export type TranscriptMode = 'live' | 'history';

export type TranscriptHistoryState = {
  items: UIItem[];
  mode: TranscriptMode;
  sessionId: SessionId | null;
  replacementRevision: number;
};

export function createTranscriptHistoryState(
  sessionId: SessionId | null,
  replacementRevision = 0
): TranscriptHistoryState {
  return { items: [], mode: 'live', sessionId, replacementRevision };
}

export function activateTranscriptHistory(
  state: TranscriptHistoryState,
  sessionId: SessionId | null,
  replacementRevision = 0
): TranscriptHistoryState {
  return state.sessionId === sessionId && state.replacementRevision === replacementRevision
    ? state
    : createTranscriptHistoryState(sessionId, replacementRevision);
}

export function updateTranscriptHistory(
  state: TranscriptHistoryState,
  sessionId: SessionId | null,
  replacementRevision: number,
  update: (current: TranscriptHistoryState) => TranscriptHistoryState
): TranscriptHistoryState {
  return state.sessionId === sessionId && state.replacementRevision === replacementRevision ? update(state) : state;
}
