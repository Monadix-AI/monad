import type { ContextPrepareCtx, ModelMessage } from '#/agent/index.ts';

import { expect, test } from 'bun:test';

import { RetrievalReinjectionContext } from '#/agent/index.ts';

const ctx = (sessionId?: string): ContextPrepareCtx | undefined =>
  sessionId ? { sessionId, emit: () => {} } : undefined;

const user = (text: string): ModelMessage => ({ role: 'user', content: text });
const sys = (text: string): ModelMessage => ({ role: 'system', content: text });

function engine(opts: {
  vec?: number[];
  hits?: { messageId: string; snippet: string; score: number }[];
  minScore?: number;
  maxResults?: number;
  embedThrows?: boolean;
}) {
  const searchCalls: unknown[] = [];
  let embedCalls = 0;
  const eng = new RetrievalReinjectionContext({
    embed: async () => {
      embedCalls++;
      if (opts.embedThrows) throw new Error('embedding provider down');
      return opts.vec;
    },
    search: (sessionId, queryVec, limit) => {
      searchCalls.push({ sessionId, queryVec, limit });
      return opts.hits ?? [];
    },
    minScore: opts.minScore,
    maxResults: opts.maxResults
  });
  return { eng, searchCalls, embedCalls: () => embedCalls };
}

test('splices relevant hits onto the last user message when above minScore', async () => {
  const { eng } = engine({
    vec: [0.1, 0.2],
    hits: [
      { messageId: 'msg_1', snippet: 'earlier: the API key rotates every 90 days', score: 0.9 },
      { messageId: 'msg_2', snippet: 'earlier: uses Bun not Node', score: 0.75 }
    ],
    minScore: 0.7
  });
  const out = await eng.prepare([sys('s'), user('what did we decide about rotation?')], ctx('ses_x'));
  const last = out[out.length - 1] as ModelMessage;
  expect(typeof last.content).toBe('string');
  expect(last.content as string).toContain('the API key rotates every 90 days');
  expect(last.content as string).toContain('uses Bun not Node');
  expect(last.content as string).toContain('<related_context>');
});

test('drops hits below minScore', async () => {
  const { eng } = engine({
    vec: [0.1],
    hits: [{ messageId: 'msg_1', snippet: 'barely related', score: 0.5 }],
    minScore: 0.7
  });
  const out = await eng.prepare([user('question')], ctx('ses_x'));
  expect((out[0] as ModelMessage).content).toBe('question'); // untouched — nothing cleared the bar
});

test('returns the same messages unchanged when no hits are found', async () => {
  const { eng } = engine({ vec: [0.1], hits: [] });
  const msgs = [user('question')];
  const out = await eng.prepare(msgs, ctx('ses_x'));
  expect(out).toBe(msgs); // same reference — no-op path
});

test('no-ops when embedding is unavailable (embed resolves undefined)', async () => {
  const { eng, searchCalls } = engine({ vec: undefined, hits: [{ messageId: 'm', snippet: 'x', score: 0.99 }] });
  const msgs = [user('question')];
  const out = await eng.prepare(msgs, ctx('ses_x'));
  expect(out).toBe(msgs);
  expect(searchCalls).toHaveLength(0); // never searches without a query vector
});

test('no-ops (does not throw) when the embed call itself fails', async () => {
  const { eng } = engine({ embedThrows: true });
  const msgs = [user('question')];
  const out = await eng.prepare(msgs, ctx('ses_x'));
  expect(out).toBe(msgs);
});

test('no-ops without a sessionId (nothing to scope the search by)', async () => {
  const { eng, searchCalls } = engine({ vec: [0.1], hits: [{ messageId: 'm', snippet: 'x', score: 0.99 }] });
  const msgs = [user('question')];
  const out = await eng.prepare(msgs); // ctx omitted entirely
  expect(out).toBe(msgs);
  expect(searchCalls).toHaveLength(0);
});

test('no-ops when there is no user message to derive a query from', async () => {
  const { eng } = engine({ vec: [0.1], hits: [{ messageId: 'm', snippet: 'x', score: 0.99 }] });
  const msgs = [sys('system only')];
  const out = await eng.prepare(msgs, ctx('ses_x'));
  expect(out).toBe(msgs);
});

test('maxResults caps the number of hits requested from search', async () => {
  const { eng, searchCalls } = engine({ vec: [0.1], hits: [], maxResults: 2 });
  await eng.prepare([user('q')], ctx('ses_x'));
  expect(searchCalls).toEqual([{ sessionId: 'ses_x', queryVec: [0.1], limit: 2 }]);
});

test('maxResults: 0 disables the stage entirely (never calls embed)', async () => {
  const { eng, embedCalls } = engine({
    vec: [0.1],
    hits: [{ messageId: 'm', snippet: 'x', score: 0.99 }],
    maxResults: 0
  });
  const msgs = [user('q')];
  const out = await eng.prepare(msgs, ctx('ses_x'));
  expect(out).toBe(msgs);
  expect(embedCalls()).toBe(0);
});
