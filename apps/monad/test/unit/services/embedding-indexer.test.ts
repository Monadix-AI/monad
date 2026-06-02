import type { EmbedResult } from '@/agent/index.ts';

import { expect, test } from 'bun:test';

import { EmbeddingIndexer } from '@/services/embedding-indexer.ts';

// In-memory store fake: messages start un-embedded; upsertEmbedding marks them done.
function fakeStore() {
  const texts = new Map<string, string>();
  const embedded = new Map<string, { vec: number[]; model?: string }>();
  const ledger: { provider: string; model: string; category: string; cost: number }[] = [];
  return {
    seed(id: string, text: string) {
      texts.set(id, text);
    },
    embedded,
    ledger,
    messagesMissingEmbedding(_sid?: string, limit?: number) {
      const out: { id: string; text: string }[] = [];
      for (const [id, text] of texts) {
        if (!embedded.has(id)) out.push({ id, text });
        if (limit && out.length >= limit) break;
      }
      return out;
    },
    pendingEmbeddingCount(_sid?: string) {
      let n = 0;
      for (const id of texts.keys()) if (!embedded.has(id)) n++;
      return n;
    },
    upsertEmbedding(id: string, vec: number[], model?: string) {
      embedded.set(id, { vec, model });
    },
    recordLedger(provider: string, model: string, category: string, _usage: unknown, costUsd = 0) {
      ledger.push({ provider, model, category, cost: costUsd });
    }
  };
}

const okEmbed = (texts: string[]): Promise<EmbedResult> =>
  Promise.resolve({
    embeddings: texts.map((_, i) => [i, i + 1]),
    usage: { inputTokens: 10, provider: 'openai', modelId: 'text-embedding-3-small' }
  });

test('drains all missing messages, tagging vectors with the model and booking an embedding ledger row', async () => {
  const store = fakeStore();
  for (let i = 0; i < 5; i++) store.seed(`m${i}`, `text ${i}`);

  const idx = new EmbeddingIndexer({
    store,
    embed: okEmbed,
    embeddingModelSpec: () => 'openai:text-embedding-3-small',
    price: () => ({ inputPerMillion: 0.02 }) as never,
    log: () => {},
    batchSize: 2
  });
  await idx.drain();

  expect(store.embedded.size).toBe(5);
  expect(store.embedded.get('m0')?.model).toBe('text-embedding-3-small');
  expect(store.ledger.every((l) => l.category === 'embedding')).toBe(true);
  expect(store.ledger.length).toBe(3); // 5 messages / batchSize 2 = 3 batches
});

test('no-op when embedding is disabled (no model configured)', async () => {
  const store = fakeStore();
  store.seed('m0', 'hi');
  let calls = 0;
  const idx = new EmbeddingIndexer({
    store,
    embed: (t) => {
      calls++;
      return okEmbed(t);
    },
    embeddingModelSpec: () => undefined,
    price: () => undefined,
    log: () => {}
  });
  idx.kick();
  await idx.drain();
  expect(calls).toBe(0);
  expect(store.embedded.size).toBe(0);
});

test('a provider error stops the pass; a later drain resumes from DB state', async () => {
  const store = fakeStore();
  for (let i = 0; i < 3; i++) store.seed(`m${i}`, `t${i}`);
  let fail = true;
  const idx = new EmbeddingIndexer({
    store,
    embed: (t) => (fail ? Promise.reject(new Error('provider down')) : okEmbed(t)),
    embeddingModelSpec: () => 'openai:e',
    price: () => undefined,
    log: () => {},
    batchSize: 10,
    errorCooldownMs: 0 // no backoff window in the test so the resume drain runs immediately
  });

  await idx.drain();
  expect(store.embedded.size).toBe(0); // first attempt failed, nothing embedded

  fail = false;
  await idx.drain();
  expect(store.embedded.size).toBe(3); // resumed from the un-embedded DB rows
});

test('concurrent kicks coalesce — overlapping work does not double-embed', async () => {
  const store = fakeStore();
  for (let i = 0; i < 4; i++) store.seed(`m${i}`, `t${i}`);
  let batches = 0;
  const idx = new EmbeddingIndexer({
    store,
    embed: (t) => {
      batches++;
      return okEmbed(t);
    },
    embeddingModelSpec: () => 'openai:e',
    price: () => undefined,
    log: () => {},
    batchSize: 4
  });

  await Promise.all([idx.drain(), idx.drain(), idx.drain()]);
  expect(store.embedded.size).toBe(4);
  expect(batches).toBe(1); // one batch covered all 4; the racing drains coalesced
});

test('respects the char budget per batch and truncates an oversized message', async () => {
  const store = fakeStore();
  store.seed('big', 'x'.repeat(50)); // larger than the whole-batch budget
  store.seed('a', 'yyy');
  store.seed('b', 'zzz');
  const seenBatches: string[][] = [];
  const idx = new EmbeddingIndexer({
    store,
    embed: (texts) => {
      seenBatches.push(texts);
      return okEmbed(texts);
    },
    embeddingModelSpec: () => 'openai:e',
    price: () => undefined,
    log: () => {},
    batchSize: 10,
    maxBatchChars: 10
  });
  await idx.drain();

  expect(seenBatches[0]).toEqual(['x'.repeat(10)]); // oversized → truncated to budget, its own batch
  expect(seenBatches[1]).toEqual(['yyy', 'zzz']); // 3+3 ≤ 10 → packed together
  expect(store.embedded.size).toBe(3);
});

test('backs off after an error — kicks/drains during the cooldown are suppressed', async () => {
  const store = fakeStore();
  store.seed('m0', 'x');
  let calls = 0;
  const idx = new EmbeddingIndexer({
    store,
    embed: () => {
      calls++;
      return Promise.reject(new Error('down'));
    },
    embeddingModelSpec: () => 'openai:e',
    price: () => undefined,
    log: () => {},
    errorCooldownMs: 100_000 // long window so the test stays inside it
  });

  await idx.drain(); // one failing attempt, arms the cooldown
  expect(calls).toBe(1);
  idx.kick();
  await idx.drain(); // both suppressed while cooling down
  expect(calls).toBe(1);
});
