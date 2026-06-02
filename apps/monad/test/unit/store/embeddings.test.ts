import type { MessageId, Session } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { createStore } from '@/store/db/index.ts';

function seedSession(store: ReturnType<typeof createStore>, title: string): Session {
  const now = new Date().toISOString();
  const s: Session = {
    id: newId('ses'),
    title,
    ownerPrincipalId: newId('prn'),
    state: 'active',
    agentIds: [],
    parentSessionId: null,
    archived: false,
    restoreCount: 0,
    createdAt: now,
    updatedAt: now
  };
  store.insertSession(s);
  return s;
}

function seedMessage(store: ReturnType<typeof createStore>, sessionId: Session['id'], text: string): MessageId {
  const id = newId('msg');
  store.insertMessage(id, sessionId, text, new Date().toISOString(), 'user');
  return id;
}

test('searchSemantic ranks float32 round-tripped vectors by cosine similarity', () => {
  const store = createStore();
  const s = seedSession(store, 'vectors');
  const close = seedMessage(store, s.id, 'about cats');
  const far = seedMessage(store, s.id, 'about budgets');
  store.upsertEmbedding(close, [0.9, 0.1, 0]);
  store.upsertEmbedding(far, [0, 0.1, 0.9]);

  const hits = store.searchSemantic([1, 0, 0]);
  expect(hits.length).toBe(2);
  expect(hits[0]?.messageId).toBe(close);
  expect(hits[1]?.messageId).toBe(far);
  expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? Number.NaN);
  expect(hits[0]?.score).toBeCloseTo(0.9 / Math.sqrt(0.82), 5);
});

test('searchSemantic skips embeddings whose dim differs from the query', () => {
  const store = createStore();
  const s = seedSession(store, 'dims');
  const matching = seedMessage(store, s.id, 'three dims');
  const mismatched = seedMessage(store, s.id, 'four dims');
  store.upsertEmbedding(matching, [1, 0, 0]);
  store.upsertEmbedding(mismatched, [1, 0, 0, 0]);

  const hits = store.searchSemantic([1, 0, 0]);
  expect(hits.map((h) => h.messageId)).toEqual([matching]);
});

test('searchSemantic respects limit after scoring all candidates', () => {
  const store = createStore();
  const s = seedSession(store, 'limit');
  for (let i = 0; i < 5; i++) {
    const id = seedMessage(store, s.id, `msg ${i}`);
    store.upsertEmbedding(id, [1, i / 10, 0]);
  }

  const hits = store.searchSemantic([1, 0, 0], { limit: 2 });
  expect(hits.length).toBe(2);
  expect(hits[0]?.snippet).toBe('msg 0'); // exact match ranks first
});

test('messagesMissingEmbedding returns only un-embedded active messages, optionally capped', () => {
  const store = createStore();
  const s = seedSession(store, 'backfill');
  const ids = Array.from({ length: 5 }, (_, i) => seedMessage(store, s.id, `m${i}`));
  store.upsertEmbedding(ids[0] as string, [1, 0, 0]); // one already embedded

  const all = store.messagesMissingEmbedding(s.id);
  expect(all.length).toBe(4); // the 4 without an embedding

  const capped = store.messagesMissingEmbedding(undefined, 2); // unscoped + capped
  expect(capped.length).toBe(2); // global backfill bounded by the limit

  expect(store.messagesMissingEmbedding(undefined, 0).length).toBe(4); // 0 → no cap
});

test('upsertEmbedding replaces an existing vector', () => {
  const store = createStore();
  const s = seedSession(store, 'replace');
  const id = seedMessage(store, s.id, 'mutable');
  store.upsertEmbedding(id, [1, 0, 0]);
  store.upsertEmbedding(id, [0, 1, 0]);

  const hits = store.searchSemantic([0, 1, 0]);
  expect(hits[0]?.messageId).toBe(id);
  expect(hits[0]?.score).toBeCloseTo(1, 5);
});

test('pendingEmbeddingCount counts un-embedded, non-empty active messages; skips embedded + empty', () => {
  const store = createStore();
  const s = seedSession(store, 'pending');
  const a = seedMessage(store, s.id, 'first message');
  seedMessage(store, s.id, 'second message');
  seedMessage(store, s.id, ''); // empty (e.g. a pending stream row) — never counted

  expect(store.pendingEmbeddingCount()).toBe(2); // two non-empty, none embedded yet
  store.upsertEmbedding(a, [1, 0]);
  expect(store.pendingEmbeddingCount()).toBe(1); // one embedded → one still pending
  expect(store.messagesMissingEmbedding().map((m) => m.text)).toEqual(['second message']);
});

test('clearEmbeddings wipes all vectors and reports the count (re-index from scratch)', () => {
  const store = createStore();
  const s = seedSession(store, 'wipe');
  const a = seedMessage(store, s.id, 'one');
  const b = seedMessage(store, s.id, 'two');
  store.upsertEmbedding(a, [1, 0], 'old-model');
  store.upsertEmbedding(b, [0, 1], 'old-model');

  expect(store.pendingEmbeddingCount()).toBe(0); // both embedded
  expect(store.clearEmbeddings()).toBe(2); // wiped both
  expect(store.pendingEmbeddingCount()).toBe(2); // now missing → indexer will rebuild
  expect(store.searchSemantic([1, 0]).length).toBe(0); // nothing left to match
});

test('staleEmbeddingCount counts vectors from a different model; NULL-model vectors are not stale', () => {
  const store = createStore();
  const s = seedSession(store, 'stale');
  const a = seedMessage(store, s.id, 'a');
  const b = seedMessage(store, s.id, 'b');
  const c = seedMessage(store, s.id, 'c');
  store.upsertEmbedding(a, [1, 0], 'old-model');
  store.upsertEmbedding(b, [0, 1], 'new-model');
  store.upsertEmbedding(c, [1, 1]); // untracked: no model recorded (NULL)

  expect(store.staleEmbeddingCount('new-model')).toBe(1); // only 'a' (old-model); NULL 'c' excluded
  expect(store.staleEmbeddingCount('old-model')).toBe(1); // only 'b'
});
