import type { MessageId, SessionId, UIItem, UIMessageItem } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  applyUiEvent,
  buildIndex,
  MAX_CANONICAL_MESSAGE_CHANGES,
  type SessionUiStreamState
} from '../../../../packages/client-rtk/src/endpoints/sessions/stream-ui-items.ts';
import {
  beginReplyTargetRequest,
  createLatestRequestGuard,
  createReplyTargetResolutionState,
  discoverReplyTargets,
  installReplyTargetResults,
  isAroundWindowForMessage,
  MAX_RETAINED_REPLY_TARGETS,
  reconcileReplyTargetsWithCanonicalChanges,
  reconcileTranscriptWithCanonicalChanges,
  releasePageFetchLock,
  runLatestRequest
} from '../../src/hooks/use-transcript-history.ts';

const sessionId = 'ses_controller' as SessionId;
const message = (id: string, replyToMessageId?: string, text = id): UIMessageItem => ({
  id,
  kind: 'message',
  parts: [{ type: 'text', text }],
  ...(replyToMessageId ? { replyToMessageId: replyToMessageId as MessageId } : {}),
  replyable: true,
  role: 'assistant',
  seq: id
});

test('incremental reply discovery preserves first-seen order and request batching', () => {
  const items = Array.from({ length: 105 }, (_, index) => message(`msg_reply_${index}`, `msg_target_${index}`));
  items.push(message('msg_target_1'));
  let state = discoverReplyTargets(createReplyTargetResolutionState(sessionId, 0), items);

  const first = beginReplyTargetRequest(state);
  state = first.state;
  state = installReplyTargetResults(
    state,
    first.messageIds,
    first.messageIds.map((id) => message(id))
  );
  const second = beginReplyTargetRequest(state);

  expect({
    first: first.messageIds,
    second: second.messageIds,
    visibleTargetRequested: first.messageIds.includes('msg_target_1') || second.messageIds.includes('msg_target_1')
  }).toEqual({
    first: [
      'msg_target_0' as MessageId,
      ...Array.from({ length: 99 }, (_, index) => `msg_target_${index + 2}` as MessageId)
    ],
    second: ['msg_target_101', 'msg_target_102', 'msg_target_103', 'msg_target_104'] as MessageId[],
    visibleTargetRequested: false
  });
});

test('reply lookup retention stays bounded without re-enqueuing evicted history on idle renders', () => {
  let state = createReplyTargetResolutionState(sessionId, 0);
  for (let offset = 0; offset < MAX_RETAINED_REPLY_TARGETS + 100; offset += 100) {
    const count = Math.min(100, MAX_RETAINED_REPLY_TARGETS + 100 - offset);
    const changedItems = Array.from({ length: count }, (_, index) =>
      message(`msg_reply_${offset + index}`, `msg_target_${offset + index}`)
    );
    state = discoverReplyTargets(state, changedItems);
    const request = beginReplyTargetRequest(state);
    state = installReplyTargetResults(
      request.state,
      request.messageIds,
      request.messageIds.map((id) => message(id))
    );
  }

  const idle = beginReplyTargetRequest(state);
  expect({
    lookupSize: state.lookup.size,
    pendingAfterEviction: idle.messageIds,
    requestedSize: idle.state.requested.size
  }).toEqual({ lookupSize: MAX_RETAINED_REPLY_TARGETS, pendingAfterEviction: [], requestedSize: 0 });
});

test('unchanged streamed items do not clone or rediscover resolved reply state', () => {
  const reply = message('msg_reply', 'msg_target');
  let state = discoverReplyTargets(createReplyTargetResolutionState(sessionId, 0), [reply]);
  const request = beginReplyTargetRequest(state);
  state = installReplyTargetResults(request.state, request.messageIds, [message('msg_target')]);

  const unchanged = discoverReplyTargets(state, [reply]);

  expect({ pending: unchanged.pending, sameState: unchanged === state }).toEqual({ pending: [], sameState: true });
});

test('canonical live misses use the detached index without scanning accumulated history', () => {
  const history = Array.from({ length: 1_000 }, (_, index) => message(`msg_history_${index}`));
  let scans = 0;
  history.findIndex = () => {
    scans += 1;
    return -1;
  };
  const index = new Map(history.map((item, itemIndex) => [`message:${item.id}`, itemIndex]));

  const reconciled = reconcileTranscriptWithCanonicalChanges(
    history,
    [{ item: message('msg_live_streaming'), kind: 'upsert', revision: 1 }],
    index
  );

  expect({ sameHistory: reconciled === history, scans }).toEqual({ sameHistory: true, scans: 0 });
});

test('canonical upsert and removal reconcile detached history and lookup-only targets', () => {
  const oldTarget = message('msg_target', undefined, 'old secret');
  const reply = message('msg_reply', 'msg_target', 'reply');
  let resolution = discoverReplyTargets(createReplyTargetResolutionState(sessionId, 0), [reply]);
  const request = beginReplyTargetRequest(resolution);
  resolution = installReplyTargetResults(request.state, request.messageIds, [oldTarget]);
  const updatedTarget = message('msg_target', undefined, 'redacted');

  let history: UIItem[] = [oldTarget, reply];
  history = reconcileTranscriptWithCanonicalChanges(history, [{ kind: 'upsert', item: updatedTarget, revision: 1 }]);
  resolution = reconcileReplyTargetsWithCanonicalChanges(resolution, [
    { kind: 'upsert', item: updatedTarget, revision: 1 }
  ]);
  const afterUpsert = {
    history: (history[0] as UIMessageItem).parts,
    lookup: resolution.lookup.get('msg_target')?.parts
  };

  history = reconcileTranscriptWithCanonicalChanges(history, [
    { kind: 'remove', messageId: 'msg_target', revision: 2 }
  ]);
  resolution = reconcileReplyTargetsWithCanonicalChanges(resolution, [
    { kind: 'remove', messageId: 'msg_target', revision: 2 }
  ]);

  expect({
    afterUpsert,
    historyIds: history.map((item) => item.id),
    lookup: resolution.lookup.get('msg_target')
  }).toEqual({
    afterUpsert: {
      history: [{ type: 'text', text: 'redacted' }],
      lookup: [{ type: 'text', text: 'redacted' }]
    },
    historyIds: ['msg_reply'],
    lookup: null
  });
});

test('canonical ledger eviction cannot resurrect a deleted target from a stale resolver', () => {
  const target = message('msg_target', undefined, 'old secret');
  const reply = message('msg_reply', 'msg_target', 'reply');
  let resolution = discoverReplyTargets(createReplyTargetResolutionState(sessionId, 0), [reply]);
  const request = beginReplyTargetRequest(resolution);
  resolution = request.state;
  const startedRevision = 0;
  const stream: SessionUiStreamState = {
    canonicalMessageChanges: [],
    canonicalMessageDroppedRevision: 0,
    canonicalMessageRevision: 0,
    items: [target],
    messageOutline: [],
    snapshotReceived: true
  };
  const streamIndex = buildIndex(stream.items);

  applyUiEvent(stream, { kind: 'remove', target: { id: target.id, kind: 'message' } }, streamIndex);
  resolution = reconcileReplyTargetsWithCanonicalChanges(resolution, stream.canonicalMessageChanges);
  for (let index = 0; index <= MAX_CANONICAL_MESSAGE_CHANGES; index++) {
    applyUiEvent(stream, { kind: 'upsert', item: message(`msg_unrelated_${index}`) }, streamIndex);
  }

  const retainedRevisions = new Map<string, number>();
  for (const change of stream.canonicalMessageChanges) {
    if (change.kind === 'upsert') retainedRevisions.set(change.item.id, change.revision);
    if (change.kind === 'remove') retainedRevisions.set(change.messageId, change.revision);
  }
  resolution = installReplyTargetResults(resolution, request.messageIds, [target], (id) => {
    return (retainedRevisions.get(id) ?? 0) === startedRevision;
  });

  expect({
    droppedRevision: stream.canonicalMessageDroppedRevision,
    retainedDelete: stream.canonicalMessageChanges.some(
      (change) => change.kind === 'remove' && change.messageId === target.id
    ),
    requested: resolution.requested.has(target.id),
    target: resolution.lookup.get(target.id)
  }).toEqual({ droppedRevision: 2, retainedDelete: false, requested: false, target: null });
});

test('a visible navigation intent cancels an older fetched intent', async () => {
  const guard = createLatestRequestGuard();
  let resolveA: ((value: string) => void) | undefined;
  const fetchedA = new Promise<string>((resolve) => {
    resolveA = resolve;
  });
  const installed: string[] = [];
  const a = runLatestRequest(
    guard,
    () => fetchedA,
    (value) => installed.push(value)
  );

  guard.invalidate();
  const visibleB = 'msg_visible_b';
  resolveA?.('msg_fetched_a');

  expect({ installed, openedA: await a, visibleB }).toEqual({
    installed: [],
    openedA: false,
    visibleB: 'msg_visible_b'
  });
});

test('a page fetched before a session or restore boundary is discarded whole, not merged', () => {
  const guard = createLatestRequestGuard();
  let items: string[] = ['live_a'];
  let cursor: string | undefined = 'cursor_a';
  const resolvePage = (token: number, page: { items: string[]; olderCursor: string | undefined }): boolean => {
    if (!guard.isCurrent(token)) return false;
    items = [...page.items, ...items];
    cursor = page.olderCursor;
    return true;
  };

  const staleToken = guard.begin();
  guard.invalidate();
  const staleMerged = resolvePage(staleToken, { items: ['older_from_a'], olderCursor: 'cursor_stale' });

  const freshToken = guard.begin();
  const freshMerged = resolvePage(freshToken, { items: ['older_from_b'], olderCursor: 'cursor_b' });

  expect({ staleMerged, freshMerged, items, cursor }).toEqual({
    staleMerged: false,
    freshMerged: true,
    items: ['older_from_b', 'live_a'],
    cursor: 'cursor_b'
  });
});

test("a superseded page request's late finally does not release the lock its successor owns", () => {
  const guard = createLatestRequestGuard();
  const fetching = { current: false };

  // Request A takes the lock under the current epoch.
  fetching.current = true;
  const tokenA = guard.begin();

  // A session switch / restore boundary supersedes A: it invalidates the guard and clears the lock.
  guard.invalidate();
  fetching.current = false;

  // Request B starts under the fresh epoch and takes the lock.
  fetching.current = true;
  const tokenB = guard.begin();

  // A's late finally fires — it must be a no-op because B owns the lock now.
  releasePageFetchLock(guard, fetching, tokenA);
  const lockAfterStaleFinally = fetching.current;
  const cWouldBeBlocked = fetching.current; // loadOlder/loadNewer bail while fetching.current is true

  // B's own finally releases the lock it owns.
  releasePageFetchLock(guard, fetching, tokenB);

  expect({
    lockAfterStaleFinally,
    cWouldBeBlocked,
    lockAfterOwnerFinally: fetching.current
  }).toEqual({ lockAfterStaleFinally: true, cWouldBeBlocked: true, lockAfterOwnerFinally: false });
});

test('an around page omitting the exact canonical target is rejected without installing', async () => {
  const guard = createLatestRequestGuard();
  const original = [message('msg_original')];
  let installed = original;
  const requested = 'msg_requested' as MessageId;
  const page = { items: [message('msg_neighbor')] };

  const opened = await runLatestRequest(
    guard,
    async () => page,
    (value) => {
      installed = value.items;
    },
    undefined,
    (value) => isAroundWindowForMessage(value.items, requested)
  );

  expect({ installed: installed.map((item) => item.id), opened }).toEqual({
    installed: ['msg_original'],
    opened: false
  });
});
