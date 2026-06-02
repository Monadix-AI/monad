// Vector search uses a pure-JS cosine fallback (bun:sqlite can't load sqlite-vec).
// A deterministic bucket embedder lets us assert semantic recall without a real model.

import type { ModelRouter } from '@/agent/index.ts';
import type { EmbeddingIndexerDeps } from '@/services/embedding-indexer.ts';

import { expect, test } from 'bun:test';

import { EmbeddingIndexer } from '@/services/embedding-indexer.ts';
import { buildHandlers, mockModel } from '../../helpers.ts';

// Message vectors are produced off the request path now, so drive the indexer to idle (the daemon
// kicks it on every message append) before asserting semantic recall.
async function indexAll(d: { store: EmbeddingIndexerDeps['store'] }, model: ModelRouter) {
  const embed = model.embed;
  if (!embed) throw new Error('semantic-search test requires a model with embed()');
  await new EmbeddingIndexer({
    store: d.store,
    embed: (texts) => embed(texts),
    embeddingModelSpec: () => 'mock:embed',
    price: () => undefined,
    log: () => {}
  }).drain();
}

const BUCKETS: Record<string, string[]> = {
  animals: ['cat', 'dog', 'pet', 'puppy', 'kitten', 'walks'],
  finance: ['money', 'budget', 'cost', 'invoice', 'price', 'quarterly'],
  weather: ['rain', 'sun', 'snow', 'weather', 'cloud']
};

/** 3-dim concept vector: count of bucket words present. */
function embedText(text: string): number[] {
  const lower = text.toLowerCase();
  return Object.values(BUCKETS).map((words) => words.reduce((n, w) => (lower.includes(w) ? n + 1 : n), 0));
}

function embeddingModel(): ModelRouter {
  return {
    ...mockModel(['ok']),
    async embed(texts: string[]) {
      return { embeddings: texts.map(embedText) };
    }
  };
}

test('semantic search recalls a conceptually-related message with no literal overlap', async () => {
  const model = embeddingModel();
  const d = buildHandlers(model);
  const { sessionId } = await d.session.create({ title: 't' });
  await d.session.generate({ sessionId, text: 'my dog likes long walks' }); // animals
  await d.session.generate({ sessionId, text: 'the quarterly budget is tight' }); // finance
  await indexAll(d, model);

  const { hits } = await d.session.search({ q: 'pet care advice', mode: 'semantic' });
  expect(hits.length).toBeGreaterThanOrEqual(1);
  expect(hits[0]?.snippet).toContain('dog'); // animals bucket beat finance
  expect(hits[0]?.matchedBy).toBe('semantic');
});

test('hybrid marks a hit found by both keyword and semantic as "both"', async () => {
  const model = embeddingModel();
  const d = buildHandlers(model);
  const { sessionId } = await d.session.create({ title: 't' });
  await d.session.generate({ sessionId, text: 'the quarterly budget is tight' });
  await indexAll(d, model);

  const { hits } = await d.session.search({ q: 'budget', mode: 'hybrid' });
  const budgetHit = hits.find((h) => h.snippet.includes('budget'));
  expect(budgetHit?.matchedBy).toBe('both');
});

test('without an embedding model, hybrid degrades to keyword', async () => {
  const d = buildHandlers(mockModel());
  const { sessionId } = await d.session.create({ title: 't' });
  await d.session.generate({ sessionId, text: 'the quarterly budget is tight' });

  const { hits } = await d.session.search({ q: 'budget', mode: 'hybrid' });
  expect(hits.length).toBe(1);
  expect(hits[0]?.matchedBy).toBe('keyword');
  // a purely-semantic query with no literal overlap yields nothing in degraded mode
  const { hits: none } = await d.session.search({ q: 'pet care advice', mode: 'hybrid' });
  expect(none.length).toBe(0);
});

// A configured embedding model whose provider/credentials fail at call time (the gateway's
// `embed` rejects) must not break search — it degrades to keyword, same as having none.
function failingEmbedModel(): ModelRouter {
  return {
    ...mockModel(['ok']),
    async embed(_texts: string[]): Promise<{ embeddings: number[][] }> {
      throw new Error('embedding provider unavailable');
    }
  };
}

test('when the embedding model errors, hybrid degrades to keyword instead of failing', async () => {
  const d = buildHandlers(failingEmbedModel());
  const { sessionId } = await d.session.create({ title: 't' });
  await d.session.generate({ sessionId, text: 'the quarterly budget is tight' });

  const { hits } = await d.session.search({ q: 'budget', mode: 'hybrid' });
  expect(hits.length).toBe(1);
  expect(hits[0]?.matchedBy).toBe('keyword');
});
