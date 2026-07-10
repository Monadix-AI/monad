import type { MessageId, SessionId, UIItem } from '@monad/protocol';

import { useLazyGetUiItemsWindowQuery } from '@monad/client-rtk';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  activateTranscriptHistory,
  createTranscriptHistoryState,
  type TranscriptMode,
  updateTranscriptHistory
} from './transcript-history-state';

interface Params {
  sessionId: SessionId | null;
  /** Oldest message id in the live window (from the bounded stream snapshot). */
  streamOldestCursor: string | undefined;
  /** Whether older messages exist before the live window. */
  streamHasMore: boolean;
}

export interface TranscriptHistory {
  /** Accumulated UI items, oldest→newest. In `live` mode these are the rows OLDER than the live
      window (merge with the live stream downstream); in `history` mode this IS the whole view. */
  items: UIItem[];
  mode: TranscriptMode;
  loadOlder: () => void;
  loadNewer: () => void;
  /** Open an inclusive window centred on a message (deep-link / search-to-message). */
  openAtMessage: (messageId: MessageId) => void;
  /** Drop the history window and return to following the live tail. */
  jumpToLive: () => void;
}

const keyOf = (i: UIItem): string => `${i.kind}:${i.id}`;

function mergeUnique(a: UIItem[], b: UIItem[]): UIItem[] {
  const seen = new Set(a.map(keyOf));
  return [...a, ...b.filter((i) => !seen.has(keyOf(i)))];
}

/**
 * History accumulator for a transcript whose live tail arrives over a bounded stream. Pages older
 * rows on scroll-up (`before`), pages newer rows on scroll-down from a deep-linked middle
 * (`after`), and opens an inclusive window around a message (`around`). In `history` mode the
 * live tail is suppressed (avoids a gap between the window and the tail) until paging newer
 * reaches the end, at which point it reconnects to `live`.
 */
export function useTranscriptHistory({ sessionId, streamOldestCursor, streamHasMore }: Params): TranscriptHistory {
  const [historyState, setHistoryState] = useState(() => createTranscriptHistoryState(sessionId));
  const [fetchWindow] = useLazyGetUiItemsWindowQuery();

  const olderCursor = useRef<string | undefined>(undefined);
  const newerCursor = useRef<string | undefined>(undefined);
  const canOlder = useRef(false);
  const canNewer = useRef(false);
  const fetching = useRef(false);
  const seeded = useRef(false);
  const activeSessionId = useRef(sessionId);
  activeSessionId.current = sessionId;
  const activeHistoryState = activateTranscriptHistory(historyState, sessionId);

  if (activeHistoryState !== historyState) {
    olderCursor.current = undefined;
    newerCursor.current = undefined;
    canOlder.current = false;
    canNewer.current = false;
    fetching.current = false;
    seeded.current = false;
    setHistoryState(activeHistoryState);
  }

  const { items, mode } = activeHistoryState;

  // Seed the older-page cursor from the live snapshot once it arrives (live mode, nothing loaded).
  useEffect(() => {
    if (mode !== 'live' || seeded.current) return;
    if (streamOldestCursor === undefined && !streamHasMore) return;
    olderCursor.current = streamOldestCursor;
    canOlder.current = streamHasMore;
    seeded.current = true;
  }, [mode, streamOldestCursor, streamHasMore]);

  const loadOlder = useCallback(() => {
    if (sessionId === null || fetching.current || !canOlder.current) return;
    const before = olderCursor.current as MessageId | undefined;
    if (!before) return;
    fetching.current = true;
    fetchWindow({ sessionId: sessionId, before })
      .unwrap()
      .then((res) => {
        if (activeSessionId.current !== sessionId) return;
        setHistoryState((state) =>
          updateTranscriptHistory(state, sessionId, (current) => ({
            ...current,
            items: mergeUnique(res.items, current.items)
          }))
        );
        olderCursor.current = res.olderCursor;
        canOlder.current = res.olderCursor !== undefined;
      })
      .catch(() => {})
      .finally(() => {
        fetching.current = false;
      });
  }, [sessionId, fetchWindow]);

  const loadNewer = useCallback(() => {
    if (sessionId === null || mode !== 'history' || fetching.current || !canNewer.current) return;
    const after = newerCursor.current as MessageId | undefined;
    if (!after) return;
    fetching.current = true;
    fetchWindow({ sessionId: sessionId, after })
      .unwrap()
      .then((res) => {
        if (activeSessionId.current !== sessionId) return;
        setHistoryState((state) =>
          updateTranscriptHistory(state, sessionId, (current) => ({
            ...current,
            items: mergeUnique(current.items, res.items),
            mode: res.newerCursor === undefined ? 'live' : current.mode
          }))
        );
        newerCursor.current = res.newerCursor;
        canNewer.current = res.newerCursor !== undefined;
      })
      .catch(() => {})
      .finally(() => {
        fetching.current = false;
      });
  }, [sessionId, mode, fetchWindow]);

  const openAtMessage = useCallback(
    (messageId: MessageId) => {
      if (sessionId === null) return;
      setHistoryState((state) =>
        updateTranscriptHistory(state, sessionId, (current) => ({ ...current, mode: 'history' }))
      );
      seeded.current = true; // don't re-seed from the stream while detached
      fetching.current = true;
      fetchWindow({ sessionId: sessionId, around: messageId })
        .unwrap()
        .then((res) => {
          if (activeSessionId.current !== sessionId) return;
          setHistoryState((state) =>
            updateTranscriptHistory(state, sessionId, (current) => ({
              ...current,
              items: res.items,
              mode: res.newerCursor === undefined ? 'live' : current.mode
            }))
          );
          olderCursor.current = res.olderCursor;
          newerCursor.current = res.newerCursor;
          canOlder.current = res.olderCursor !== undefined;
          canNewer.current = res.newerCursor !== undefined;
        })
        .catch(() => {})
        .finally(() => {
          fetching.current = false;
        });
    },
    [sessionId, fetchWindow]
  );

  const jumpToLive = useCallback(() => {
    setHistoryState((state) =>
      updateTranscriptHistory(state, sessionId, (current) => ({ ...current, items: [], mode: 'live' }))
    );
    olderCursor.current = streamOldestCursor;
    newerCursor.current = undefined;
    canOlder.current = streamHasMore;
    canNewer.current = false;
    seeded.current = true;
  }, [sessionId, streamOldestCursor, streamHasMore]);

  return { items, mode, loadOlder, loadNewer, openAtMessage, jumpToLive };
}
