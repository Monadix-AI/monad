// applyUiEvent maintains a position index so per-token upserts stay O(1). These tests pin the
// behaviour the index replaced (a linear findIndex scan): correct upsert-in-place, append, removal,
// and re-add after removal, plus snapshot reset.

import type { SessionUiEvent, UIItem } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  applyUiEvent,
  buildIndex,
  MAX_CANONICAL_MESSAGE_CHANGES,
  type SessionUiStreamState
} from '../../src/endpoints/sessions/stream-ui-items.ts';

const item = (kind: string, id: string, extra: Record<string, unknown> = {}): UIItem =>
  ({ kind, id, ...extra }) as unknown as UIItem;
const snapshot = (items: UIItem[]): SessionUiEvent => ({ kind: 'snapshot', items }) as SessionUiEvent;
const upsert = (it: UIItem): SessionUiEvent => ({ kind: 'upsert', item: it }) as SessionUiEvent;
const remove = (kind: string, id: string): SessionUiEvent =>
  ({ kind: 'remove', target: { kind, id } }) as SessionUiEvent;
const streamState = (items: UIItem[] = []): SessionUiStreamState => ({
  canonicalMessageChanges: [],
  canonicalMessageDroppedRevision: 0,
  canonicalMessageRevision: 0,
  items,
  messageOutline: [],
  snapshotReceived: false
});

test('the snapshot outline remains complete while live user-message upserts and removals reconcile it', () => {
  const draft = streamState();
  const index = buildIndex(draft.items);
  applyUiEvent(
    draft,
    {
      kind: 'snapshot',
      items: [
        item('message', 'msg_user_2', {
          parts: [{ type: 'text', text: 'Second' }],
          role: 'user',
          seq: '2'
        }),
        item('message', 'msg_user_buffered', {
          parts: [{ type: 'text', text: 'Buffered' }],
          role: 'user',
          seq: '3'
        })
      ],
      messageOutline: [
        { id: 'msg_user_1', text: 'First' },
        { id: 'msg_user_2', text: 'Second' }
      ]
    } as SessionUiEvent,
    index
  );
  applyUiEvent(
    draft,
    upsert(
      item('message', 'msg_user_3', {
        parts: [{ type: 'text', text: 'Third' }],
        role: 'user',
        seq: '3'
      })
    ),
    index
  );
  applyUiEvent(draft, remove('message', 'msg_user_2'), index);

  expect({
    outline: draft.messageOutline,
    renderedIds: draft.items.map((entry) => entry.id)
  }).toEqual({
    outline: [
      { id: 'msg_user_1', text: 'First' },
      { id: 'msg_user_buffered', text: 'Buffered', at: '3' },
      { id: 'msg_user_3', text: 'Third', at: '3' }
    ],
    renderedIds: ['msg_user_buffered', 'msg_user_3']
  });
});

test('snapshot resets items and index', () => {
  const draft = streamState([item('message', 'old')]);
  const index = buildIndex(draft.items);
  applyUiEvent(draft, snapshot([item('message', 'a'), item('tool', 'b')]), index);
  expect(draft.items.map((i) => i.id)).toEqual(['a', 'b']);
  expect(draft.snapshotReceived).toBe(true);
  expect(index.get('tool:b')).toBe(1);
});

test('non-snapshot events do not finish initial transcript loading', () => {
  const draft = streamState();
  const index = buildIndex(draft.items);
  applyUiEvent(draft, upsert(item('message', 'live')), index);
  expect(draft.snapshotReceived).toBe(false);
});

test('replacement snapshots advance the transcript replacement revision', () => {
  const draft = { ...streamState([item('message', 'old')]), replacementRevision: 2 };
  const index = buildIndex(draft.items);
  applyUiEvent(draft, { kind: 'snapshot', items: [], replacesTranscript: true } as SessionUiEvent, index);
  expect(draft.replacementRevision).toBe(3);
});

test('a duplicate reconnect snapshot does not restart canonical reply resolution', () => {
  const draft = streamState();
  const index = buildIndex(draft.items);
  const initial = snapshot([item('message', 'msg_reply')]);

  applyUiEvent(draft, initial, index);
  applyUiEvent(draft, initial, index);

  expect({ changes: draft.canonicalMessageChanges, revision: draft.canonicalMessageRevision }).toEqual({
    changes: [{ kind: 'reset', revision: 1 }],
    revision: 1
  });
});

test('upsert updates in place by key, appends when new, preserving order', () => {
  const draft = streamState();
  const index = buildIndex(draft.items);
  applyUiEvent(draft, upsert(item('message', 'm1', { seq: 1 })), index);
  applyUiEvent(draft, upsert(item('message', 'm2', { seq: 1 })), index);
  applyUiEvent(draft, upsert(item('message', 'm1', { seq: 2 })), index); // update existing
  expect(draft.items.map((i) => i.id)).toEqual(['m1', 'm2']);
  expect((draft.items[0] as unknown as { seq: number }).seq).toBe(2); // updated in place, not duplicated
  expect(draft.items).toHaveLength(2);
});

test('same id under different kinds are distinct entries', () => {
  const draft = streamState();
  const index = buildIndex(draft.items);
  applyUiEvent(draft, upsert(item('message', 'x')), index);
  applyUiEvent(draft, upsert(item('tool', 'x')), index);
  expect(draft.items).toHaveLength(2);
});

test('remove drops the entry and keeps the index consistent for later upserts', () => {
  const draft = streamState();
  const index = buildIndex(draft.items);
  applyUiEvent(draft, upsert(item('message', 'a')), index);
  applyUiEvent(draft, upsert(item('message', 'b')), index);
  applyUiEvent(draft, upsert(item('message', 'c')), index);
  applyUiEvent(draft, remove('message', 'a'), index); // shifts b,c down
  expect(draft.items.map((i) => i.id)).toEqual(['b', 'c']);
  // After the shift, updating 'c' must hit the right slot, not the stale pre-removal position.
  applyUiEvent(draft, upsert(item('message', 'c', { seq: 9 })), index);
  expect(draft.items.map((i) => i.id)).toEqual(['b', 'c']);
  expect((draft.items[1] as unknown as { seq: number }).seq).toBe(9);
  // Re-adding a removed id appends fresh.
  applyUiEvent(draft, upsert(item('message', 'a')), index);
  expect(draft.items.map((i) => i.id)).toEqual(['b', 'c', 'a']);
});

test('clears a prior streamError on any event', () => {
  const draft = { ...streamState(), streamError: { kind: 'transient' as const } };
  const index = buildIndex(draft.items);
  applyUiEvent(draft, upsert(item('message', 'a')), index);
});

test('snapshot captures oldestCursor and hasMore from the bounded window', () => {
  const draft = streamState();
  const index = buildIndex(draft.items);
  const snap: SessionUiEvent = {
    kind: 'snapshot',
    items: [item('message', 'a')],
    oldestCursor: 'msg_a00000000000',
    hasMore: true
  } as SessionUiEvent;
  applyUiEvent(draft, snap, index);
  expect(draft.oldestCursor).toBe('msg_a00000000000');
  expect(draft.hasMore).toBe(true);
});

test('upsert and remove leave the snapshot cursors untouched', () => {
  const draft: SessionUiStreamState = {
    ...streamState([item('message', 'a')]),
    oldestCursor: 'msg_a00000000000',
    snapshotReceived: true,
    hasMore: true
  };
  const index = buildIndex(draft.items);
  applyUiEvent(draft, upsert(item('message', 'b')), index);
  expect(draft.oldestCursor).toBe('msg_a00000000000');
  expect(draft.hasMore).toBe(true);
  applyUiEvent(draft, remove('message', 'b'), index);
  expect(draft.oldestCursor).toBe('msg_a00000000000');
  expect(draft.hasMore).toBe(true);
});

test('canonical message changes retain only the latest body or tombstone for each message', () => {
  const draft = streamState();
  const index = buildIndex(draft.items);
  applyUiEvent(
    draft,
    upsert(
      item('message', 'msg_target', {
        parts: [{ type: 'text', text: 'secret before redaction' }],
        replyable: true,
        role: 'assistant',
        seq: '1'
      })
    ),
    index
  );
  applyUiEvent(
    draft,
    upsert(
      item('message', 'msg_target', {
        parts: [{ type: 'text', text: 'redacted' }],
        replyable: false,
        role: 'assistant',
        seq: '1'
      })
    ),
    index
  );
  applyUiEvent(draft, remove('message', 'msg_target'), index);

  expect({
    cached: JSON.stringify(draft.canonicalMessageChanges),
    changes: draft.canonicalMessageChanges,
    revision: draft.canonicalMessageRevision
  }).toEqual({
    cached: '[{"kind":"remove","messageId":"msg_target","revision":3}]',
    changes: [{ kind: 'remove', messageId: 'msg_target', revision: 3 }],
    revision: 3
  });
});

test('canonical message change retention is bounded and reports an unobserved floor', () => {
  const draft = streamState();
  const index = buildIndex(draft.items);
  for (let i = 0; i <= MAX_CANONICAL_MESSAGE_CHANGES; i++) {
    applyUiEvent(
      draft,
      upsert(
        item('message', `msg_${i}`, {
          parts: [],
          replyable: true,
          role: 'assistant',
          seq: `${i}`
        })
      ),
      index
    );
  }

  expect({
    dropped: draft.canonicalMessageDroppedRevision,
    firstRetainedRevision: Math.min(...draft.canonicalMessageChanges.map((change) => change.revision)),
    length: draft.canonicalMessageChanges.length,
    newest: draft.canonicalMessageChanges.some(
      (change) => change.kind === 'upsert' && change.item.id === `msg_${MAX_CANONICAL_MESSAGE_CHANGES}`
    )
  }).toEqual({ dropped: 1, firstRetainedRevision: 2, length: MAX_CANONICAL_MESSAGE_CHANGES, newest: true });
});

test('a live-upserted user message carries its timestamp into the outline immediately, not only after a snapshot', () => {
  const draft = streamState();
  const index = buildIndex(draft.items);
  applyUiEvent(draft, snapshot([]), index);
  applyUiEvent(
    draft,
    upsert(
      item('message', 'msg_live', {
        parts: [{ type: 'text', text: 'Live message' }],
        role: 'user',
        seq: '2026-08-08T01:00:00.000Z'
      })
    ),
    index
  );

  expect(draft.messageOutline).toEqual([{ id: 'msg_live', text: 'Live message', at: '2026-08-08T01:00:00.000Z' }]);
});
