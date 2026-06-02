import type { CanonicalMessageChange } from '@monad/client-rtk';
import type { MessageId, SessionId, UIItem, UIMessageItem } from '@monad/protocol';

import { useLazyGetUiItemsWindowQuery, useLazyResolveUiMessagesQuery } from '@monad/client-rtk';
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
  /** Changes when restore/reset replaces the daemon's authoritative transcript. */
  streamReplacementRevision?: number;
  /** The bounded live window shown beside accumulated history. Reply targets are resolved from this
      visible set without adding the lookup result to transcript history. */
  liveItems?: readonly UIItem[];
  /** Bounded latest-per-message mutations emitted by the live stream cache. */
  streamCanonicalMessageChanges?: readonly CanonicalMessageChange[];
  /** Highest canonical mutation revision dropped from the bounded stream ledger. */
  streamCanonicalMessageDroppedRevision?: number;
}

interface OpenAtMessageOptions {
  /** The target is already in the rendered transcript; this still advances the navigation epoch. */
  targetVisible?: boolean;
}

export interface TranscriptHistory {
  /** Accumulated UI items, oldest→newest. In `live` mode these are the rows OLDER than the live
      window (merge with the live stream downstream); in `history` mode this IS the whole view. */
  items: UIItem[];
  mode: TranscriptMode;
  loadOlder: () => void;
  loadNewer: () => void;
  /** Open an inclusive window centred on a message (deep-link / search-to-message). */
  openAtMessage: (messageId: MessageId, options?: OpenAtMessageOptions) => Promise<boolean>;
  /** Lookup-only reply targets. `null` means resolution completed but the target is unavailable. */
  replyTargets: ReadonlyMap<string, UIMessageItem | null>;
  /** Drop the history window and return to following the live tail. */
  jumpToLive: () => void;
}

const keyOf = (i: UIItem): string => `${i.kind}:${i.id}`;
const MAX_REPLY_TARGETS_PER_REQUEST = 100;
const MAX_PENDING_REPLY_TARGETS = 256;
const MAX_REPLY_TARGET_RETRIES = 3;
export const MAX_RETAINED_REPLY_TARGETS = 256;
const EMPTY_ITEMS: readonly UIItem[] = [];
const EMPTY_CANONICAL_CHANGES: readonly CanonicalMessageChange[] = [];

export interface ReplyTargetResolutionState {
  lookup: Map<string, UIMessageItem | null>;
  lookupOrder: string[];
  pending: MessageId[];
  requested: Set<string>;
  revision: number;
  sessionId: SessionId | null;
  visibleMessageIds: Set<string>;
}

export function createReplyTargetResolutionState(
  sessionId: SessionId | null,
  revision: number
): ReplyTargetResolutionState {
  return {
    lookup: new Map(),
    lookupOrder: [],
    pending: [],
    requested: new Set(),
    revision,
    sessionId,
    visibleMessageIds: new Set()
  };
}

function cacheReplyTarget(
  state: ReplyTargetResolutionState,
  id: string,
  item: UIMessageItem | null
): ReplyTargetResolutionState {
  const lookup = new Map(state.lookup);
  const lookupOrder = state.lookupOrder.filter((entry) => entry !== id);
  lookup.set(id, item);
  lookupOrder.push(id);
  while (lookupOrder.length > MAX_RETAINED_REPLY_TARGETS) {
    const evicted = lookupOrder.shift();
    if (evicted !== undefined) lookup.delete(evicted);
  }
  return { ...state, lookup, lookupOrder };
}

export function discoverReplyTargets(
  state: ReplyTargetResolutionState,
  changedItems: readonly UIItem[],
  options: { replaceVisible?: boolean } = {}
): ReplyTargetResolutionState {
  if (!options.replaceVisible) {
    const pendingIds = new Set(state.pending);
    const hasChange = changedItems.some(
      (item) =>
        item.kind === 'message' &&
        (!state.visibleMessageIds.has(item.id) ||
          (item.replyToMessageId !== undefined &&
            !state.visibleMessageIds.has(item.replyToMessageId) &&
            !state.lookup.has(item.replyToMessageId) &&
            !state.requested.has(item.replyToMessageId) &&
            !pendingIds.has(item.replyToMessageId)))
    );
    if (!hasChange) return state;
  }
  const visibleMessageIds = options.replaceVisible ? new Set<string>() : new Set(state.visibleMessageIds);
  for (const item of changedItems) {
    if (item.kind === 'message') visibleMessageIds.add(item.id);
  }
  const pending = state.pending.filter((id) => !visibleMessageIds.has(id));
  const pendingIds = new Set(pending);
  for (const item of changedItems) {
    if (item.kind !== 'message' || !item.replyToMessageId) continue;
    const id = item.replyToMessageId;
    if (
      visibleMessageIds.has(id) ||
      state.lookup.has(id) ||
      state.requested.has(id) ||
      pendingIds.has(id) ||
      pending.length + state.requested.size >= MAX_PENDING_REPLY_TARGETS
    ) {
      continue;
    }
    pendingIds.add(id);
    pending.push(id);
  }
  return { ...state, pending, visibleMessageIds };
}

export function beginReplyTargetRequest(state: ReplyTargetResolutionState): {
  messageIds: MessageId[];
  state: ReplyTargetResolutionState;
} {
  const messageIds = state.pending.slice(0, MAX_REPLY_TARGETS_PER_REQUEST);
  if (messageIds.length === 0) return { messageIds, state };
  const requested = new Set(state.requested);
  for (const id of messageIds) requested.add(id);
  return {
    messageIds,
    state: { ...state, pending: state.pending.slice(messageIds.length), requested }
  };
}

export function installReplyTargetResults(
  state: ReplyTargetResolutionState,
  requestedIds: readonly MessageId[],
  resolvedItems: readonly UIMessageItem[],
  canInstall: (id: MessageId) => boolean = () => true
): ReplyTargetResolutionState {
  const resolved = new Map(resolvedItems.map((item) => [item.id, item]));
  const requested = releaseReplyTargetRequests(state.requested, requestedIds);
  let next = { ...state, requested };
  for (const id of requestedIds) {
    if (state.requested.has(id) && canInstall(id)) next = cacheReplyTarget(next, id, resolved.get(id) ?? null);
  }
  return next;
}

function retryReplyTargetRequests(
  state: ReplyTargetResolutionState,
  failedIds: readonly MessageId[]
): ReplyTargetResolutionState {
  const requested = releaseReplyTargetRequests(state.requested, failedIds);
  const pending = [...state.pending];
  const pendingIds = new Set(pending);
  for (const id of failedIds) {
    if (
      state.lookup.has(id) ||
      state.visibleMessageIds.has(id) ||
      pendingIds.has(id) ||
      pending.length + requested.size >= MAX_PENDING_REPLY_TARGETS
    ) {
      continue;
    }
    pendingIds.add(id);
    pending.push(id);
  }
  return { ...state, pending, requested };
}

export function reconcileTranscriptWithCanonicalChanges(
  items: UIItem[],
  changes: readonly CanonicalMessageChange[],
  index?: Map<string, number>
): UIItem[] {
  let next = items;
  for (const change of [...changes].sort((a, b) => a.revision - b.revision)) {
    if (change.kind === 'reset') {
      next = [];
      index?.clear();
      continue;
    }
    if (change.kind === 'remove') {
      const key = `message:${change.messageId}`;
      const at = index
        ? (index.get(key) ?? -1)
        : next.findIndex((item) => item.kind === 'message' && item.id === change.messageId);
      if (at < 0) continue;
      next = next.filter((_, itemIndex) => itemIndex !== at);
      if (index) {
        index.clear();
        for (let i = 0; i < next.length; i++) index.set(keyOf(next[i] as UIItem), i);
      }
      continue;
    }
    const key = `message:${change.item.id}`;
    const at = index
      ? (index.get(key) ?? -1)
      : next.findIndex((item) => item.kind === 'message' && item.id === change.item.id);
    if (at < 0) continue;
    next = next.slice();
    next[at] = change.item;
  }
  return next;
}

export function reconcileReplyTargetsWithCanonicalChanges(
  state: ReplyTargetResolutionState,
  changes: readonly CanonicalMessageChange[],
  resetItems: readonly UIItem[] = EMPTY_ITEMS
): ReplyTargetResolutionState {
  let next = state;
  for (const change of [...changes].sort((a, b) => a.revision - b.revision)) {
    if (change.kind === 'reset') {
      next = discoverReplyTargets(createReplyTargetResolutionState(state.sessionId, state.revision), resetItems, {
        replaceVisible: true
      });
      continue;
    }
    if (change.kind === 'upsert') {
      if (next.lookup.has(change.item.id)) next = cacheReplyTarget(next, change.item.id, change.item);
      next = discoverReplyTargets(
        {
          ...next,
          pending: next.pending.filter((id) => id !== change.item.id),
          requested: releaseReplyTargetRequests(next.requested, [change.item.id])
        },
        [change.item]
      );
      continue;
    }
    const visibleMessageIds = new Set(next.visibleMessageIds);
    visibleMessageIds.delete(change.messageId);
    next = cacheReplyTarget(
      {
        ...next,
        pending: next.pending.filter((id) => id !== change.messageId),
        requested: releaseReplyTargetRequests(next.requested, [change.messageId]),
        visibleMessageIds
      },
      change.messageId,
      null
    );
  }
  return next;
}

export function replyTargetRequestIds(
  visibleItems: readonly UIItem[],
  lookup: ReadonlyMap<string, UIMessageItem | null>,
  requested = new Set<string>()
): MessageId[] {
  const visibleMessageIds = new Set(visibleItems.flatMap((item) => (item.kind === 'message' ? [item.id] : [])));
  const ids: MessageId[] = [];
  const seen = new Set<string>();
  for (const item of visibleItems) {
    if (item.kind !== 'message' || !item.replyToMessageId) continue;
    const id = item.replyToMessageId;
    if (visibleMessageIds.has(id) || lookup.has(id) || requested.has(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length === MAX_REPLY_TARGETS_PER_REQUEST) break;
  }
  return ids;
}

export function releaseReplyTargetRequests(requested: ReadonlySet<string>, failedIds: readonly string[]): Set<string> {
  const next = new Set(requested);
  for (const id of failedIds) next.delete(id);
  return next;
}

export function createLatestRequestGuard(): {
  begin: () => number;
  invalidate: () => void;
  isCurrent: (token: number) => boolean;
} {
  let current = 0;
  return {
    begin: () => ++current,
    invalidate: () => {
      current += 1;
    },
    isCurrent: (token) => token === current
  };
}

// A page request holds the single `fetching` lock for its duration. When a session switch or
// restore/reset supersedes it, the boundary invalidates the guard AND clears the lock so a fresh
// page request can take it. The superseded request's late `finally` must therefore NOT clear the
// lock — its successor owns it now, and clearing it would let a third request start concurrently
// and invalidate the owner mid-flight (dropping a legitimate page and corrupting cursor progression).
export function releasePageFetchLock(
  guard: ReturnType<typeof createLatestRequestGuard>,
  fetching: { current: boolean },
  token: number
): void {
  if (guard.isCurrent(token)) fetching.current = false;
}

export async function runLatestRequest<T>(
  guard: ReturnType<typeof createLatestRequestGuard>,
  load: () => Promise<T>,
  install: (value: T) => void,
  onLatestSettled?: () => void,
  canInstall: (value: T) => boolean = () => true
): Promise<boolean> {
  const token = guard.begin();
  try {
    const value = await load();
    if (!guard.isCurrent(token) || !canInstall(value)) return false;
    install(value);
    return true;
  } catch {
    return false;
  } finally {
    if (guard.isCurrent(token)) onLatestSettled?.();
  }
}

export function isAroundWindowForMessage(items: readonly UIItem[], messageId: MessageId): boolean {
  return items.some((item) => item.kind === 'message' && item.id === messageId);
}

function mergeUnique(a: UIItem[], b: UIItem[]): UIItem[] {
  const seen = new Set(a.map(keyOf));
  return [...a, ...b.filter((i) => !seen.has(keyOf(i)))];
}

function replaceTranscriptIndex(index: Map<string, number>, items: readonly UIItem[]): void {
  index.clear();
  for (let i = 0; i < items.length; i++) index.set(keyOf(items[i] as UIItem), i);
}

/**
 * History accumulator for a transcript whose live tail arrives over a bounded stream. Pages older
 * rows on scroll-up (`before`), pages newer rows on scroll-down from a deep-linked middle
 * (`after`), and opens an inclusive window around a message (`around`). In `history` mode the
 * live tail is suppressed (avoids a gap between the window and the tail) until paging newer
 * reaches the end, at which point it reconnects to `live`.
 */
export function useTranscriptHistory({
  sessionId,
  streamOldestCursor,
  streamHasMore,
  streamReplacementRevision = 0,
  liveItems = EMPTY_ITEMS,
  streamCanonicalMessageChanges = EMPTY_CANONICAL_CHANGES,
  streamCanonicalMessageDroppedRevision = 0
}: Params): TranscriptHistory {
  const [historyState, setHistoryState] = useState(() =>
    createTranscriptHistoryState(sessionId, streamReplacementRevision)
  );
  const [fetchWindow] = useLazyGetUiItemsWindowQuery();
  const [resolveMessages] = useLazyResolveUiMessagesQuery();
  const [replyResolution, setReplyResolution] = useState(() =>
    createReplyTargetResolutionState(sessionId, streamReplacementRevision)
  );

  const olderCursor = useRef<string | undefined>(undefined);
  const newerCursor = useRef<string | undefined>(undefined);
  const canOlder = useRef(false);
  const canNewer = useRef(false);
  const fetching = useRef(false);
  const seeded = useRef(false);
  const openRequestGuard = useRef(createLatestRequestGuard());
  const replyRequestInFlight = useRef(false);
  const replyRetryAttempts = useRef(new Map<string, number>());
  const replyRetryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const canonicalMessageRevisions = useRef(new Map<string, number>());
  const lastCanonicalMessageRevision = useRef(0);
  const canonicalResetRevision = useRef(0);
  const detachedHistoryIndex = useRef(new Map<string, number>());
  const liveItemsRef = useRef(liveItems);
  liveItemsRef.current = liveItems;
  const activeSessionId = useRef(sessionId);
  activeSessionId.current = sessionId;
  // A page fetch dispatched for one (session, replacement-revision) must be discarded wholesale if the
  // session was switched or the transcript rebuilt by a restore/reset before it resolves — otherwise
  // its rows AND its pagination cursors, which belong to the superseded view, corrupt the rebuilt one.
  const pageRequestGuard = useRef(createLatestRequestGuard());
  const activeHistoryState = activateTranscriptHistory(historyState, sessionId, streamReplacementRevision);
  const activeReplyResolution =
    replyResolution.sessionId === sessionId && replyResolution.revision === streamReplacementRevision
      ? replyResolution
      : createReplyTargetResolutionState(sessionId, streamReplacementRevision);

  if (activeHistoryState !== historyState) {
    olderCursor.current = undefined;
    newerCursor.current = undefined;
    canOlder.current = false;
    canNewer.current = false;
    fetching.current = false;
    seeded.current = false;
    openRequestGuard.current.invalidate();
    pageRequestGuard.current.invalidate();
    for (const timer of replyRetryTimers.current.values()) clearTimeout(timer);
    replyRetryTimers.current.clear();
    replyRetryAttempts.current.clear();
    replyRequestInFlight.current = false;
    canonicalMessageRevisions.current.clear();
    lastCanonicalMessageRevision.current = 0;
    canonicalResetRevision.current = 0;
    detachedHistoryIndex.current.clear();
    setHistoryState(activeHistoryState);
  }
  if (activeReplyResolution !== replyResolution) setReplyResolution(activeReplyResolution);

  const { items, mode } = activeHistoryState;

  useEffect(() => {
    if (sessionId === null) return;
    const lastRevision = lastCanonicalMessageRevision.current;
    const retainedChanges = streamCanonicalMessageChanges
      .filter((change) => change.revision > lastRevision)
      .sort((a, b) => a.revision - b.revision);
    const missedChanges = streamCanonicalMessageDroppedRevision > lastRevision;
    if (!missedChanges && retainedChanges.length === 0) return;
    const changes: CanonicalMessageChange[] = missedChanges
      ? [{ kind: 'reset', revision: streamCanonicalMessageDroppedRevision }, ...retainedChanges]
      : retainedChanges;
    if (changes.some((change) => change.kind === 'reset')) {
      canonicalMessageRevisions.current.clear();
      canonicalResetRevision.current = Math.max(
        canonicalResetRevision.current,
        ...changes.filter((change) => change.kind === 'reset').map((change) => change.revision)
      );
      for (const timer of replyRetryTimers.current.values()) clearTimeout(timer);
      replyRetryTimers.current.clear();
      replyRetryAttempts.current.clear();
      olderCursor.current = streamOldestCursor;
      newerCursor.current = undefined;
      canOlder.current = streamHasMore;
      canNewer.current = false;
      seeded.current = true;
    }
    const retainedRevisions = new Map<string, number>();
    for (const change of streamCanonicalMessageChanges) {
      if (change.kind === 'upsert') retainedRevisions.set(change.item.id, change.revision);
      if (change.kind === 'remove') retainedRevisions.set(change.messageId, change.revision);
    }
    canonicalMessageRevisions.current = retainedRevisions;
    for (const change of changes) {
      if (change.kind === 'reset') continue;
      const id = change.kind === 'upsert' ? change.item.id : change.messageId;
      const timer = replyRetryTimers.current.get(id);
      if (timer) clearTimeout(timer);
      replyRetryTimers.current.delete(id);
      replyRetryAttempts.current.delete(id);
    }
    const latestRevision = Math.max(lastRevision, ...changes.map((change) => change.revision));
    lastCanonicalMessageRevision.current = latestRevision;
    setHistoryState((state) =>
      updateTranscriptHistory(state, sessionId, streamReplacementRevision, (current) => ({
        ...current,
        items: reconcileTranscriptWithCanonicalChanges(current.items, changes, detachedHistoryIndex.current),
        mode: changes.some((change) => change.kind === 'reset') ? 'live' : current.mode
      }))
    );
    setReplyResolution((state) => {
      if (state.sessionId !== sessionId || state.revision !== streamReplacementRevision) return state;
      return reconcileReplyTargetsWithCanonicalChanges(state, changes, liveItems);
    });
  }, [
    liveItems,
    sessionId,
    streamCanonicalMessageChanges,
    streamCanonicalMessageDroppedRevision,
    streamHasMore,
    streamOldestCursor,
    streamReplacementRevision
  ]);

  useEffect(() => {
    if (sessionId === null || activeReplyResolution.pending.length === 0 || replyRequestInFlight.current) return;
    const request = beginReplyTargetRequest(activeReplyResolution);
    if (request.messageIds.length === 0) return;
    const requestedIds = request.messageIds;
    const startedRevisions = new Map(
      requestedIds.map((id) => [id, canonicalMessageRevisions.current.get(id) ?? 0] as const)
    );
    const startedResetRevision = canonicalResetRevision.current;
    replyRequestInFlight.current = true;
    setReplyResolution((state) => {
      if (state.sessionId !== sessionId || state.revision !== streamReplacementRevision) return state;
      const requested = new Set(state.requested);
      for (const id of requestedIds) requested.add(id);
      const requestedSet = new Set(requestedIds);
      return { ...state, pending: state.pending.filter((id) => !requestedSet.has(id)), requested };
    });
    void resolveMessages({ messageIds: requestedIds, sessionId })
      .unwrap()
      .then((response) => {
        if (activeSessionId.current !== sessionId) return;
        for (const id of requestedIds) replyRetryAttempts.current.delete(id);
        setReplyResolution((state) => {
          if (state.sessionId !== sessionId || state.revision !== streamReplacementRevision) return state;
          return installReplyTargetResults(
            state,
            requestedIds,
            response.items,
            (id) =>
              canonicalResetRevision.current === startedResetRevision &&
              (canonicalMessageRevisions.current.get(id) ?? 0) === startedRevisions.get(id)
          );
        });
      })
      .catch(() => {
        for (const id of requestedIds) {
          if (replyRetryTimers.current.has(id)) continue;
          const attempt = (replyRetryAttempts.current.get(id) ?? 0) + 1;
          replyRetryAttempts.current.set(id, attempt);
          if (attempt >= MAX_REPLY_TARGET_RETRIES) {
            setReplyResolution((state) => {
              if (state.sessionId !== sessionId || state.revision !== streamReplacementRevision) return state;
              return installReplyTargetResults(
                state,
                [id],
                [],
                () =>
                  canonicalResetRevision.current === startedResetRevision &&
                  (canonicalMessageRevisions.current.get(id) ?? 0) === startedRevisions.get(id)
              );
            });
            replyRetryAttempts.current.delete(id);
            continue;
          }
          const timer = setTimeout(
            () => {
              replyRetryTimers.current.delete(id);
              if (
                canonicalResetRevision.current !== startedResetRevision ||
                (canonicalMessageRevisions.current.get(id) ?? 0) !== startedRevisions.get(id)
              ) {
                setReplyResolution((state) =>
                  state.sessionId === sessionId && state.revision === streamReplacementRevision
                    ? { ...state, requested: releaseReplyTargetRequests(state.requested, [id]) }
                    : state
                );
                return;
              }
              setReplyResolution((state) => {
                if (state.sessionId !== sessionId || state.revision !== streamReplacementRevision) return state;
                return retryReplyTargetRequests(state, [id]);
              });
            },
            Math.min(30_000, 1_000 * 2 ** (attempt - 1))
          );
          replyRetryTimers.current.set(id, timer);
        }
      })
      .finally(() => {
        replyRequestInFlight.current = false;
        setReplyResolution((state) => {
          if (state.sessionId !== sessionId || state.revision !== streamReplacementRevision) return state;
          return { ...state };
        });
      });
  }, [activeReplyResolution, resolveMessages, sessionId, streamReplacementRevision]);

  useEffect(
    () => () => {
      for (const timer of replyRetryTimers.current.values()) clearTimeout(timer);
      replyRetryTimers.current.clear();
    },
    []
  );

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
    const pageToken = pageRequestGuard.current.begin();
    fetchWindow({ sessionId: sessionId, before })
      .unwrap()
      .then((res) => {
        if (!pageRequestGuard.current.isCurrent(pageToken)) return;
        setHistoryState((state) =>
          updateTranscriptHistory(state, sessionId, streamReplacementRevision, (current) => {
            const nextItems = mergeUnique(res.items, current.items);
            replaceTranscriptIndex(detachedHistoryIndex.current, nextItems);
            return { ...current, items: nextItems };
          })
        );
        setReplyResolution((state) =>
          state.sessionId === sessionId && state.revision === streamReplacementRevision
            ? discoverReplyTargets(state, res.items)
            : state
        );
        olderCursor.current = res.olderCursor;
        canOlder.current = res.olderCursor !== undefined;
      })
      .catch(() => {})
      .finally(() => {
        releasePageFetchLock(pageRequestGuard.current, fetching, pageToken);
      });
  }, [sessionId, streamReplacementRevision, fetchWindow]);

  const loadNewer = useCallback(() => {
    if (sessionId === null || mode !== 'history' || fetching.current || !canNewer.current) return;
    const after = newerCursor.current as MessageId | undefined;
    if (!after) return;
    fetching.current = true;
    const pageToken = pageRequestGuard.current.begin();
    fetchWindow({ sessionId: sessionId, after })
      .unwrap()
      .then((res) => {
        if (!pageRequestGuard.current.isCurrent(pageToken)) return;
        setHistoryState((state) =>
          updateTranscriptHistory(state, sessionId, streamReplacementRevision, (current) => {
            const nextItems = mergeUnique(current.items, res.items);
            replaceTranscriptIndex(detachedHistoryIndex.current, nextItems);
            return {
              ...current,
              items: nextItems,
              mode: res.newerCursor === undefined ? 'live' : current.mode
            };
          })
        );
        setReplyResolution((state) =>
          state.sessionId === sessionId && state.revision === streamReplacementRevision
            ? discoverReplyTargets(state, res.items)
            : state
        );
        newerCursor.current = res.newerCursor;
        canNewer.current = res.newerCursor !== undefined;
      })
      .catch(() => {})
      .finally(() => {
        releasePageFetchLock(pageRequestGuard.current, fetching, pageToken);
      });
  }, [sessionId, mode, streamReplacementRevision, fetchWindow]);

  const openAtMessage = useCallback(
    async (messageId: MessageId, options: OpenAtMessageOptions = {}): Promise<boolean> => {
      if (sessionId === null) return false;
      if (options.targetVisible) {
        openRequestGuard.current.invalidate();
        fetching.current = false;
        return true;
      }
      fetching.current = true;
      return runLatestRequest(
        openRequestGuard.current,
        () => fetchWindow({ sessionId: sessionId, around: messageId }).unwrap(),
        (res) => {
          if (activeSessionId.current !== sessionId) return;
          seeded.current = true;
          const nextMode = res.newerCursor === undefined ? 'live' : 'history';
          setHistoryState((state) =>
            updateTranscriptHistory(state, sessionId, streamReplacementRevision, (current) => {
              replaceTranscriptIndex(detachedHistoryIndex.current, res.items);
              return { ...current, items: res.items, mode: nextMode };
            })
          );
          setReplyResolution((state) =>
            state.sessionId === sessionId && state.revision === streamReplacementRevision
              ? discoverReplyTargets(state, nextMode === 'live' ? [...res.items, ...liveItemsRef.current] : res.items, {
                  replaceVisible: true
                })
              : state
          );
          olderCursor.current = res.olderCursor;
          newerCursor.current = res.newerCursor;
          canOlder.current = res.olderCursor !== undefined;
          canNewer.current = res.newerCursor !== undefined;
        },
        () => {
          fetching.current = false;
        },
        (res) => isAroundWindowForMessage(res.items, messageId)
      );
    },
    [sessionId, streamReplacementRevision, fetchWindow]
  );

  const jumpToLive = useCallback(() => {
    openRequestGuard.current.invalidate();
    fetching.current = false;
    detachedHistoryIndex.current.clear();
    setHistoryState((state) =>
      updateTranscriptHistory(state, sessionId, streamReplacementRevision, (current) => ({
        ...current,
        items: [],
        mode: 'live'
      }))
    );
    setReplyResolution((state) =>
      state.sessionId === sessionId && state.revision === streamReplacementRevision
        ? discoverReplyTargets(state, liveItemsRef.current, { replaceVisible: true })
        : state
    );
    olderCursor.current = streamOldestCursor;
    newerCursor.current = undefined;
    canOlder.current = streamHasMore;
    canNewer.current = false;
    seeded.current = true;
  }, [sessionId, streamOldestCursor, streamHasMore, streamReplacementRevision]);

  return {
    items,
    mode,
    loadOlder,
    loadNewer,
    openAtMessage,
    replyTargets: activeReplyResolution.lookup,
    jumpToLive
  };
}
