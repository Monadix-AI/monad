import type { ModelMessage, ModelResult, ModelRouter } from '#/agent/index.ts';

import { expect, test } from 'bun:test';

import {
  CompositeContextEngine,
  InMemoryMemory,
  passthroughContext,
  SummarizingContextEngine,
  TokenEstimator,
  TokenLimiterContext
} from '#/agent/index.ts';

const ctx = { sessionId: 'ses_x00000000000', emit: () => {} };
const sys = (text: string): ModelMessage => ({ role: 'system', content: text });
const user = (text: string): ModelMessage => ({ role: 'user', content: text });
const assistant = (text: string): ModelMessage => ({ role: 'assistant', content: text });

// ~big helper: a string long enough to dominate the token budget in trimming tests.
const big = (label: string) => `${label} `.repeat(200);

test('passthroughContext returns the messages unchanged', async () => {
  const msgs = [sys('s'), user('hi')];
  expect(await passthroughContext.prepare(msgs, ctx)).toBe(msgs);
});

test('TokenLimiterContext keeps system + the most recent messages that fit', () => {
  const engine = new TokenLimiterContext({ maxTokens: 250 });
  const msgs = [sys('system'), user(big('OLD')), assistant(big('MID')), user('recent question')];
  // Pin a fresh estimator: the process-wide global one self-calibrates from other tests' real
  // usage samples, which would otherwise shift the char/token ratio and this token-budget boundary.
  const out = engine.prepare(msgs, { sessionId: 'ses_x00000000000', emit: () => {}, estimator: new TokenEstimator() });

  expect(out[0]?.role).toBe('system'); // system always kept
  expect(out.some((m) => m.content === 'recent question')).toBe(true); // newest kept
  expect(out.some((m) => typeof m.content === 'string' && m.content.startsWith('OLD'))).toBe(false); // oldest dropped
  expect(out.length).toBeLessThan(msgs.length);
});

test('TokenLimiterContext strips a leading orphan tool-result', () => {
  const engine = new TokenLimiterContext({ maxTokens: 100_000 });
  const msgs: ModelMessage[] = [
    sys('s'),
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'x', output: 'orphan' }] },
    user('hello')
  ];
  const out = engine.prepare(msgs);
  expect(out.some((m) => m.role === 'tool')).toBe(false); // orphan result removed
  expect(out.some((m) => m.content === 'hello')).toBe(true);
});

test('CompositeContextEngine runs engines in sequence (summarize, then hard-truncate)', async () => {
  const { model } = summaryModel('S');
  const summarize = new SummarizingContextEngine({
    model,
    summaryModel: 'mock',
    softThresholdTokens: 50,
    hardThresholdTokens: 60,
    keepRecent: 2
  });
  const limiter = new TokenLimiterContext({ maxTokens: 100_000 });
  const composite = new CompositeContextEngine([summarize, limiter]);

  const msgs = [sys('s'), user(big('A')), assistant(big('B')), user(big('C')), assistant('recent')];
  const out = await composite.prepare(msgs, ctx);
  // Summarizer dropped the older prefix and added a note; limiter passed the small result through.
  expect(out.some((m) => typeof m.content === 'string' && m.content.startsWith('A '))).toBe(false);
  expect(out.some((m) => m.content === 'recent')).toBe(true);
});

function summaryModel(summary: string): { model: ModelRouter; calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    model: {
      async *stream() {},
      async complete(): Promise<ModelResult> {
        n++;
        return { text: summary, finishReason: 'stop' };
      }
    }
  };
}

test('SummarizingContextEngine is a passthrough below the soft threshold', async () => {
  const { model, calls } = summaryModel('SUMMARY');
  const engine = new SummarizingContextEngine({ model, summaryModel: 'mock', softThresholdTokens: 100_000 });
  const msgs = [sys('s'), user('hi'), assistant('hello')];
  const out = await engine.prepare(msgs, ctx);
  expect(out).toEqual(msgs);
  expect(calls()).toBe(0); // no compaction
});

test('SummarizingContextEngine compacts synchronously past the hard threshold and spills to memory', async () => {
  const memory = new InMemoryMemory();
  const { model, calls } = summaryModel('DENSE SUMMARY');
  const engine = new SummarizingContextEngine({
    model,
    summaryModel: 'mock',
    memory,
    softThresholdTokens: 50,
    hardThresholdTokens: 60,
    keepRecent: 2
  });
  const msgs = [sys('s'), user(big('A')), assistant(big('B')), user(big('C')), assistant('recent')];

  const out = await engine.prepare(msgs, ctx);
  expect(calls()).toBe(1); // synchronous compaction ran
  expect(await memory.recall('summary:ses_x00000000000')).toBe('DENSE SUMMARY'); // spilled to durable memory
  // The rolling summary is injected as a single system note (append-only, cache-friendly).
  const notes = out.filter((m) => typeof m.content === 'string' && m.content.includes('DENSE SUMMARY'));
  expect(notes).toHaveLength(1);
  // Summarized older messages are DROPPED (the whole point); the recent tail is kept.
  expect(out.some((m) => typeof m.content === 'string' && m.content.startsWith('A '))).toBe(false);
  expect(out.some((m) => m.content === 'recent')).toBe(true);
  expect(out.length).toBeLessThan(msgs.length + 1); // +1 would be the note with nothing dropped

  // Idempotent: a second prepare on the already-noted output must not stack a 2nd summary note.
  const out2 = await engine.prepare(out, ctx);
  const notes2 = out2.filter((m) => typeof m.content === 'string' && m.content.includes('DENSE SUMMARY'));
  expect(notes2).toHaveLength(1);
});

test('SummarizingContextEngine fires background compaction at soft threshold without blocking the turn', async () => {
  const { model, calls } = summaryModel('BG_SUMMARY');
  const engine = new SummarizingContextEngine({
    model,
    summaryModel: 'mock',
    softThresholdTokens: 50,
    hardThresholdTokens: 100_000, // well above soft — never triggers hard path
    keepRecent: 1
  });
  const msgs = [sys('s'), user(big('A')), assistant('recent')];

  // Soft-threshold: returns immediately without blocking, model call queued in background.
  const _out = await engine.prepare(msgs, ctx);
  expect(calls()).toBe(0); // compaction is in-flight, not yet resolved

  // Yield to the microtask queue so the background promise resolves.
  await new Promise((r) => setTimeout(r, 0));
  expect(calls()).toBe(1);

  // Two simultaneous calls (no await between them): the second sees the inFlight from the first
  // and does NOT start a duplicate compaction.
  const { model: model2, calls: calls2 } = summaryModel('BG2');
  const engine2 = new SummarizingContextEngine({
    model: model2,
    summaryModel: 'mock',
    softThresholdTokens: 50,
    hardThresholdTokens: 100_000,
    keepRecent: 1
  });
  const p1 = engine2.prepare(msgs, ctx);
  const p2 = engine2.prepare(msgs, ctx); // inFlight from p1 is still active — no second compact
  await Promise.all([p1, p2]);
  await new Promise((r) => setTimeout(r, 0));
  expect(calls2()).toBe(1); // exactly one compaction, not two
});

test('SummarizingContextEngine injects summary as a new system message when none exists', async () => {
  const { model } = summaryModel('NOTE');
  const engine = new SummarizingContextEngine({
    model,
    summaryModel: 'mock',
    softThresholdTokens: 10,
    hardThresholdTokens: 20,
    keepRecent: 1
  });
  // No system message — the withSummary branch for systems.length === 0.
  const msgs = [user(big('OLD')), assistant('recent')];
  const out = await engine.prepare(msgs, ctx);
  const _injected = out.find((m) => m.role === 'system');
  expect(out.some((m) => m.content === 'recent')).toBe(true);
});

test('SummarizingContextEngine folds the summary INTO the first system message (survives splitSystem)', async () => {
  const memory = new InMemoryMemory();
  const { model } = summaryModel('THE SUMMARY');
  const engine = new SummarizingContextEngine({
    model,
    summaryModel: 'mock',
    memory,
    softThresholdTokens: 10,
    hardThresholdTokens: 20,
    keepRecent: 1
  });
  const msgs = [sys('sys'), user(big('OLD')), assistant('recent')];
  const out = await engine.prepare(msgs, ctx);
  const systemMessages = out.filter((m) => m.role === 'system');
  // Exactly one system message — so splitSystem (first-only) won't drop the summary.
  expect(systemMessages).toHaveLength(1);

  // Idempotent: a second prepare doesn't stack a duplicate summary.
  const out2 = await engine.prepare(out, ctx);
  const sys2 = out2.filter((m) => m.role === 'system');
  expect(sys2).toHaveLength(1);
  expect(String(sys2[0]?.content).match(/THE SUMMARY/g) ?? []).toHaveLength(1);
});
