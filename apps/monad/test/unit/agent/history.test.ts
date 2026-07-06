import type { SessionId } from '@monad/protocol';
import type {
  ChatMessage,
  DurableSummary,
  ModelMessage,
  ModelResult,
  ModelRouter,
  SummaryStore
} from '@/agent/index.ts';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { AgentLoop, DurableSummarizer, InMemoryMessageRepo, replayHistory } from '@/agent/index.ts';

// A MessageSource over an in-memory list that supports the after-cursor (by array index of id).
function source(rows: ChatMessage[]) {
  return {
    list: () => rows,
    listSince: (_sid: string, afterId: string) => {
      const i = rows.findIndex((r) => r.id === afterId);
      return i === -1 ? rows : rows.slice(i + 1);
    }
  };
}

function memStore(): SummaryStore & { rec: () => DurableSummary | null } {
  let rec: DurableSummary | null = null;
  return {
    rec: () => rec,
    load: () => rec,
    save: (_s, r) => {
      rec = r;
    }
  };
}

function summaryModel(text: string): { model: ModelRouter; calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    model: {
      async *stream() {},
      async complete(): Promise<ModelResult> {
        n++;
        return { text, finishReason: 'stop' };
      }
    }
  };
}

/** A model that captures the last user-turn content sent to complete(). */
function capturingModel(reply: string): { model: ModelRouter; lastPrompt: () => string } {
  let last = '';
  return {
    lastPrompt: () => last,
    model: {
      async *stream() {},
      async complete(req): Promise<ModelResult> {
        const userMsg = [...(req.messages ?? [])].reverse().find((m) => m.role === 'user');
        last = typeof userMsg?.content === 'string' ? userMsg.content : '';
        return { text: reply, finishReason: 'stop' };
      }
    }
  };
}

/** A summary model whose complete() blocks on an externally-released gate — lets a test hold a
 *  background compaction "in flight" and assert non-blocking behavior deterministically. */
function gatedModel(text: string): { model: ModelRouter; started: () => number; release: () => void } {
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return {
    started: () => started,
    release: () => release(),
    model: {
      async *stream() {},
      async complete(): Promise<ModelResult> {
        started++;
        await gate;
        return { text, finishReason: 'stop' };
      }
    }
  };
}

/** Drain microtasks until this session's background compaction has settled. */
async function settle(eng: DurableSummarizer, sid: string): Promise<void> {
  for (let i = 0; i < 20 && eng.pendingCompaction(sid); i++) await new Promise((r) => setTimeout(r, 0));
}

const msg = (id: string, role: ChatMessage['role'], text: string): ChatMessage => ({
  id,
  transcriptTargetId: 'ses_x',
  role,
  text,
  createdAt: ''
});
const big = (s: string) => s.repeat(300);

test('below threshold: no summary, returns full window unchanged', async () => {
  const rows = [msg('m1', 'user', 'hi'), msg('m2', 'assistant', 'hello')];
  const { model, calls } = summaryModel('S');
  const eng = new DurableSummarizer({
    messages: source(rows),
    summaryStore: memStore(),
    model,
    summaryModel: 'mock',
    softThresholdTokens: 100_000
  });
  const out = await eng.assemble('ses_x');
  expect(out.messages).toHaveLength(2);
  expect(calls()).toBe(0);
});

test('replayHistory coalesces adjacent user messages for model input only', () => {
  const replayed = replayHistory([msg('m1', 'user', 'A'), msg('m2', 'user', 'B')]);

  expect(replayed).toEqual([{ role: 'user', content: 'A\n\nB' }]);
});

test('replayHistory does not coalesce user messages across an assistant turn', () => {
  const replayed = replayHistory([msg('m1', 'user', 'A'), msg('m2', 'assistant', 'answer'), msg('m3', 'user', 'B')]);

  expect(replayed).toEqual([
    { role: 'user', content: 'A' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'B' }
  ]);
});

test('manual compact() folds the full loaded window even below the soft threshold', async () => {
  const rows = [
    msg('m1', 'user', 'a'),
    msg('m2', 'assistant', 'b'),
    msg('m3', 'user', 'c'),
    msg('m4', 'assistant', 'recent')
  ];
  const store = memStore();
  const { model, lastPrompt } = capturingModel('DENSE');
  const eng = new DurableSummarizer({
    messages: source(rows),
    summaryStore: store,
    model,
    summaryModel: 'mock',
    softThresholdTokens: 1_000_000, // would never auto-compact
    keepRecent: 1
  });

  // Forced compaction ignores the threshold and the keepRecent tail: it summarizes the whole
  // currently loaded window, including the final message.
  const res = await eng.compact('ses_x');
  expect(res.compacted).toBe(4);
  expect(lastPrompt()).toContain('user: a');
  expect(lastPrompt()).toContain('assistant: recent');
  expect(store.rec()?.uptoMessageId).toBe('m4');
  expect(store.rec()?.summary).toBe('DENSE');

  // A second compact finds no loaded rows left (since the boundary advanced to the last row) → no-op.
  const again = await eng.compact('ses_x');
  expect(again.compacted).toBe(0);
});

test('PreCompact: preserve instructions are folded into the summarization system prompt', async () => {
  const rows = [
    msg('m1', 'user', big('A')),
    msg('m2', 'assistant', big('B')),
    msg('m3', 'user', big('C')),
    msg('m4', 'assistant', 'recent')
  ];
  let capturedSystem = '';
  const calls: { trigger: string; tokens: number }[] = [];
  const model: ModelRouter = {
    async *stream() {},
    async complete(req): Promise<ModelResult> {
      const sys = (req.messages ?? []).find((m) => m.role === 'system');
      capturedSystem = typeof sys?.content === 'string' ? sys.content : '';
      return { text: 'DENSE', finishReason: 'stop' };
    }
  };
  const eng = new DurableSummarizer({
    messages: source(rows),
    summaryStore: memStore(),
    model,
    summaryModel: 'mock',
    softThresholdTokens: 50,
    keepRecent: 1,
    preCompact: async (info) => {
      calls.push({ trigger: info.trigger, tokens: info.tokens });
      return ['keep the API key rotation decision'];
    }
  });

  await eng.assemble('ses_x');
  expect(calls).toHaveLength(1);
  expect(calls[0]?.trigger).toBe('soft');
  expect(calls[0]?.tokens).toBeGreaterThan(0);
  expect(capturedSystem).toContain('keep the API key rotation decision');
});

test('over threshold: compacts older rows, advances the durable boundary, keeps recent tail', async () => {
  const rows = [
    msg('m1', 'user', big('A')),
    msg('m2', 'assistant', big('B')),
    msg('m3', 'user', big('C')),
    msg('m4', 'assistant', 'recent')
  ];
  const store = memStore();
  const { model, calls } = summaryModel('DENSE');
  const eng = new DurableSummarizer({
    messages: source(rows),
    summaryStore: store,
    model,
    summaryModel: 'mock',
    softThresholdTokens: 50,
    keepRecent: 1
  });

  const out = await eng.assemble('ses_x');
  expect(calls()).toBe(1);
  expect(out.summary).toBe('DENSE');
  // Older folded into summary; only the recent tail (keepRecent=1) returned.
  expect(out.messages).toHaveLength(1);
  expect(out.messages[0]?.content).toBe('recent');
  // Boundary persisted at the last older row (m3), so the next load starts after it.
  expect(store.rec()?.uptoMessageId).toBe('m3');
});

test('reflector condenses the rolling summary once it exceeds the reflect threshold', async () => {
  const rows = [msg('m1', 'user', big('A')), msg('m2', 'assistant', big('B')), msg('m3', 'user', 'recent')];
  const store = memStore();
  // First complete() = the over-long summary; second = the condensed (reflected) one.
  let n = 0;
  const model: ModelRouter = {
    async *stream() {},
    async complete(): Promise<ModelResult> {
      n++;
      return { text: n === 1 ? 'long '.repeat(30) : 'CONDENSED', finishReason: 'stop' };
    }
  };
  const eng = new DurableSummarizer({
    messages: source(rows),
    summaryStore: store,
    model,
    summaryModel: 'mock',
    softThresholdTokens: 50,
    keepRecent: 1,
    reflectThresholdTokens: 10
  });

  const out = await eng.assemble('ses_x');
  expect(n).toBe(2); // summarize, then a reflect/GC pass
  expect(out.summary).toBe('CONDENSED');
  expect(store.rec()?.summary).toBe('CONDENSED'); // the condensed form is what's persisted
});

test('next turn loads only since the boundary (bounded), folding the prior summary', async () => {
  const rows = [
    msg('m1', 'user', big('A')),
    msg('m2', 'assistant', big('B')),
    msg('m3', 'user', big('C')),
    msg('m4', 'assistant', 'recent'),
    msg('m5', 'user', 'next question') // arrived after the boundary
  ];
  const store = memStore();
  store.save('ses_x', { summary: 'PRIOR', uptoMessageId: 'm3' });
  const { model, calls } = summaryModel('UNUSED');
  const eng = new DurableSummarizer({
    messages: source(rows),
    summaryStore: store,
    model,
    summaryModel: 'mock',
    softThresholdTokens: 100_000, // under threshold → no re-compaction
    keepRecent: 1
  });

  const out = await eng.assemble('ses_x');
  expect(calls()).toBe(0); // no recompaction
  expect(out.summary).toBe('PRIOR'); // prior summary carried forward
  // Only m4, m5 (since boundary m3) loaded — not the full transcript.
  expect(out.messages.map((m) => m.content)).toEqual(['recent', 'next question']);
});

test('the loop keeps durable summary out of the cached system prompt', async () => {
  const seen: ModelMessage[][] = [];
  const captureModel: ModelRouter = {
    async *stream() {},
    async complete(req): Promise<ModelResult> {
      seen.push(req.messages);
      return { text: 'ok', finishReason: 'stop' };
    }
  };
  const rows = [msg('m1', 'user', 'q'), msg('m2', 'assistant', 'a')];
  const store = memStore();
  store.save('ses_x', { summary: 'EARLIER STUFF', uptoMessageId: 'm0' });
  const history = new DurableSummarizer({
    messages: source(rows),
    summaryStore: store,
    model: captureModel,
    summaryModel: 'mock',
    softThresholdTokens: 100_000
  });
  const loop = new AgentLoop({
    model: captureModel,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    history
  });
  await loop.runBlock(newId('ses') as SessionId, 'hi');

  const prompt = seen[0] as ModelMessage[];
  const systems = prompt.filter((m) => m.role === 'system');
  expect(systems).toHaveLength(1);
  expect(String(systems[0]?.content)).not.toContain('EARLIER STUFF');
  const users = prompt.filter((m) => m.role === 'user');
  expect(users).toHaveLength(1);
  expect(String(users[0]?.content)).toContain('EARLIER STUFF');
  expect(String(users[0]?.content)).toContain('<context_summary>');
});

test('re-compaction folds the prior summary into the new one (priorBlock in summarize)', async () => {
  // Turn 2: boundary is already set, but the window is still over threshold → second compaction.
  // The prior summary must be prepended to the summarize prompt so nothing is lost.
  const rows = [msg('m4', 'user', big('D')), msg('m5', 'assistant', big('E')), msg('m6', 'user', 'recent')];
  const store = memStore();
  store.save('ses_x', { summary: 'TURN1_SUMMARY', uptoMessageId: 'm3' });

  const { model, lastPrompt } = capturingModel('TURN2_SUMMARY');
  const eng = new DurableSummarizer({
    messages: source(rows),
    summaryStore: store,
    model,
    summaryModel: 'mock',
    softThresholdTokens: 50, // both m4+m5 push over threshold again
    keepRecent: 1
  });

  const out = await eng.assemble('ses_x');
  expect(out.summary).toBe('TURN2_SUMMARY');
  // Prior summary is prepended to the user turn so the model receives accumulated context.
  expect(lastPrompt()).toContain('TURN1_SUMMARY');
  expect(lastPrompt()).toContain('Previous summary:');
  // Boundary advances to m5 (the last older row).
  expect(store.rec()?.uptoMessageId).toBe('m5');
});

// ── background (Mastra-style) compaction ────────────────────────────────────────

test('background: soft threshold compacts WITHOUT blocking; the result lands on a later turn', async () => {
  const rows = [msg('m1', 'user', big('A')), msg('m2', 'assistant', big('B')), msg('m3', 'user', 'recent')];
  const store = memStore();
  const g = gatedModel('BG_SUMMARY');
  const eng = new DurableSummarizer({
    messages: source(rows),
    summaryStore: store,
    model: g.model,
    summaryModel: 'mock',
    softThresholdTokens: 50,
    keepRecent: 1,
    background: true
  });

  // Non-blocking: the turn returns the FULL window with nothing compacted yet.
  const out = await eng.assemble('ses_x');
  expect(out.messages).toHaveLength(3);
  expect(eng.pendingCompaction('ses_x')).toBe(true);

  // Let the background compaction finish; it persists durably.
  g.release();
  await settle(eng, 'ses_x');
  expect(eng.pendingCompaction('ses_x')).toBe(false);
  expect(store.rec()?.summary).toBe('BG_SUMMARY');
  expect(store.rec()?.uptoMessageId).toBe('m2'); // older = [m1, m2]

  // A later turn picks up the durable summary + the bounded (since-boundary) window.
  const out2 = await eng.assemble('ses_x');
  expect(out2.summary).toBe('BG_SUMMARY');
  expect(out2.messages.map((m) => m.content)).toEqual(['recent']);
});

test('background: a second turn does not start a duplicate compaction while one is in flight', async () => {
  const rows = [msg('m1', 'user', big('A')), msg('m2', 'assistant', big('B')), msg('m3', 'user', 'recent')];
  const g = gatedModel('BG');
  const eng = new DurableSummarizer({
    messages: source(rows),
    summaryStore: memStore(),
    model: g.model,
    summaryModel: 'mock',
    softThresholdTokens: 50,
    keepRecent: 1,
    background: true
  });

  await eng.assemble('ses_x'); // kicks a background compaction (gated)
  await eng.assemble('ses_x'); // soft again, but inFlight → no second kick
  expect(g.started()).toBe(1);

  g.release();
  await settle(eng, 'ses_x');
  expect(g.started()).toBe(1); // exactly one compaction total
});

test('background: a hard-threshold turn waits for the in-flight compaction instead of racing a duplicate', async () => {
  // Deterministic sizing independent of the shared estimator ratio: tiny rows keep turn 1 under the
  // hard threshold (soft → background), huge rows push turn 2 over it (hard → must wait for in-flight).
  const tiny = (s: string) => s.repeat(10);
  const huge = (s: string) => s.repeat(4000);
  const rows = [msg('m1', 'user', tiny('a')), msg('m2', 'assistant', tiny('b')), msg('m3', 'user', tiny('c'))];
  const store = memStore();
  const g = gatedModel('BG');
  const eng = new DurableSummarizer({
    messages: source(rows),
    summaryStore: store,
    model: g.model,
    summaryModel: 'mock',
    softThresholdTokens: 1,
    hardThresholdTokens: 100,
    keepRecent: 1,
    background: true
  });

  // Turn 1: window well under hard → background kicked (gated, not committed).
  await eng.assemble('ses_x');
  expect(eng.pendingCompaction('ses_x')).toBe(true);

  // Huge rows arrive, pushing the window over the hard threshold before the background finished.
  rows.push(msg('m4', 'user', huge('D')), msg('m5', 'assistant', huge('E')));

  // Turn 2 is at/over hard with a compaction in flight → it must WAIT, not launch a duplicate.
  const p = eng.assemble('ses_x');
  await new Promise((r) => setTimeout(r, 0));
  expect(g.started()).toBe(1); // no second compaction started concurrently — turn 2 is parked on inFlight

  g.release();
  const out2 = await p;
  await settle(eng, 'ses_x');
  expect(out2.summary).toBe('BG'); // turn 2 proceeds off the advanced boundary + durable summary
});

test('background: a hard-threshold turn with no in-flight compaction compacts synchronously', async () => {
  const rows = [msg('m1', 'user', big('A')), msg('m2', 'assistant', big('B')), msg('m3', 'user', 'recent')];
  const store = memStore();
  const { model, calls } = summaryModel('SYNC');
  const eng = new DurableSummarizer({
    messages: source(rows),
    summaryStore: store,
    model,
    summaryModel: 'mock',
    softThresholdTokens: 50,
    hardThresholdTokens: 50, // window is already over hard
    keepRecent: 1,
    background: true
  });

  const out = await eng.assemble('ses_x');
  expect(calls()).toBe(1); // compacted inline this turn (no background needed)
  expect(out.summary).toBe('SYNC');
  expect(out.messages.map((m) => m.content)).toEqual(['recent']);
  expect(store.rec()?.uptoMessageId).toBe('m2');
  expect(eng.pendingCompaction('ses_x')).toBe(false);
});
