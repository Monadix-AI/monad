import type { ContextPrepareCtx, ModelMessage } from '#/agent/index.ts';

import { expect, test } from 'bun:test';

import { EVICTED_MARKER, TokenEstimator, ToolResultEvictionContext } from '#/agent/index.ts';

// Fresh estimator (ratio 4 chars/token) so eviction sizing doesn't ride on the self-calibrating
// global one, which other tests move. Trigger is gated via lastRealInputTokens for determinism.
const est = () => new TokenEstimator();
const ctx = (lastRealInputTokens?: number): ContextPrepareCtx => ({
  sessionId: 'ses_x00000000000',
  emit: () => {},
  estimator: est(),
  ...(lastRealInputTokens !== undefined ? { lastRealInputTokens } : {})
});

const sys = (text: string): ModelMessage => ({ role: 'system', content: text });
const user = (text: string): ModelMessage => ({ role: 'user', content: text });
const call = (id: string, name: string, input: unknown): ModelMessage => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: id, toolName: name, input }]
});
const result = (id: string, name: string, output: string): ModelMessage => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: id, toolName: name, output }]
});

// An 800-char output ≈ 200 tokens at ratio 4.
const bigOutput = (label: string) => `${label}`.padEnd(800, '.');

/** One concurrent round: an assistant message firing `n` parallel calls + the single `tool` message
 *  that carries all `n` results — exactly how runToolCalls persists a step. */
function concurrentRound(step: number, n: number, big = true): ModelMessage[] {
  const calls = Array.from({ length: n }, (_, k) => ({
    type: 'tool-call' as const,
    toolCallId: `s${step}c${k}`,
    toolName: 'read_file',
    input: { path: `/s${step}f${k}.ts` }
  }));
  const results = Array.from({ length: n }, (_, k) => ({
    type: 'tool-result' as const,
    toolCallId: `s${step}c${k}`,
    toolName: 'read_file',
    output: big ? bigOutput(`S${step}R${k}`) : `S${step}R${k}`
  }));
  return [
    { role: 'assistant', content: calls },
    { role: 'tool', content: results }
  ];
}

/** A transcript of N sequential single-result rounds, framed by a system + trailing user message. */
function transcript(n: number): ModelMessage[] {
  const msgs: ModelMessage[] = [sys('system')];
  for (let i = 0; i < n; i++) {
    msgs.push(call(`t${i}`, 'read_file', { path: `/f${i}.ts` }));
    msgs.push(result(`t${i}`, 'read_file', bigOutput(`OUT${i}`)));
  }
  msgs.push(user('what next?'));
  return msgs;
}

function outputs(msgs: ModelMessage[]): string[] {
  return msgs.flatMap((m) =>
    Array.isArray(m.content)
      ? m.content.filter((p) => p.type === 'tool-result').map((p) => (p as { output: string }).output)
      : []
  );
}

test('does nothing when window occupancy is below the trigger fraction', () => {
  const engine = new ToolResultEvictionContext({
    contextLimit: 1000,
    atFraction: 0.5,
    keepRecentRounds: 1,
    clearAtLeast: 1
  });
  const msgs = transcript(5);
  // lastRealInputTokens=100 < trigger(500): untouched, same reference returned.
  const out = engine.prepare(msgs, ctx(100));
  expect(out).toBe(msgs);
});

test('evicts older rounds to placeholders, keeping the most recent K rounds verbatim', () => {
  const engine = new ToolResultEvictionContext({
    contextLimit: 1000,
    atFraction: 0.5,
    keepRecentRounds: 2,
    clearAtLeast: 1,
    minResultTokens: 1
  });
  const msgs = transcript(5); // 5 single-result rounds
  const out = engine.prepare(msgs, ctx(600)); // above trigger
  const outs = outputs(out);
  const evicted = outs.filter((o) => o.startsWith(EVICTED_MARKER));
  const verbatim = outs.filter((o) => !o.startsWith(EVICTED_MARKER));
  expect(evicted).toHaveLength(3); // 5 - keepRecentRounds(2)
  expect(verbatim).toHaveLength(2);
  // The most recent two rounds (OUT3, OUT4) survive verbatim.
  expect(verbatim.every((o) => o.startsWith('OUT3') || o.startsWith('OUT4'))).toBe(true);
});

test('protects a recent concurrent round whole — never splits a parallel batch', () => {
  const engine = new ToolResultEvictionContext({
    contextLimit: 1000,
    atFraction: 0.5,
    keepRecentRounds: 1, // protect only the LAST round…
    clearAtLeast: 1,
    minResultTokens: 1
  });
  // Round 0: one old single result. Round 1 (most recent): 6 parallel results.
  const msgs: ModelMessage[] = [
    sys('s'),
    call('old', 'read_file', { path: '/old.ts' }),
    result('old', 'read_file', bigOutput('OLD')),
    ...concurrentRound(1, 6),
    user('go')
  ];
  const out = engine.prepare(msgs, ctx(600));
  const outs = outputs(out);
  // All 6 of the recent parallel batch survive verbatim (whole round protected)…
  expect(outs.filter((o) => o.startsWith('S1R'))).toHaveLength(6);
  // …and the lone older round is the only thing evicted.
  expect(outs.filter((o) => o.startsWith(EVICTED_MARKER))).toHaveLength(1);
});

test('evicts an older concurrent round as a unit (all its parallel results together)', () => {
  const engine = new ToolResultEvictionContext({
    contextLimit: 1000,
    atFraction: 0.5,
    keepRecentRounds: 1,
    clearAtLeast: 1,
    minResultTokens: 1
  });
  // Round 0 (older): 5 parallel results. Round 1 (recent): 1 result.
  const msgs: ModelMessage[] = [sys('s'), ...concurrentRound(0, 5), ...concurrentRound(1, 1), user('go')];
  const out = engine.prepare(msgs, ctx(600));
  const outs = outputs(out);
  // The entire older batch is evicted together — not one part left behind.
  expect(outs.filter((o) => o.startsWith(EVICTED_MARKER))).toHaveLength(5);
  // The recent round stays verbatim.
  expect(outs.filter((o) => o.startsWith('S1R'))).toHaveLength(1);
});

test('keepRecentRounds: 0 evicts every round (no slice(-0) protect-all bug)', () => {
  const engine = new ToolResultEvictionContext({
    contextLimit: 1000,
    atFraction: 0.5,
    keepRecentRounds: 0,
    clearAtLeast: 1,
    minResultTokens: 1
  });
  const msgs = transcript(4);
  const out = engine.prepare(msgs, ctx(600));
  const outs = outputs(out);
  expect(outs.every((o) => o.startsWith(EVICTED_MARKER))).toBe(true); // nothing protected → all evicted
  expect(outs).toHaveLength(4);
});

test('preserves tool-call/tool-result pairing (no message dropped, only output text swapped)', () => {
  const engine = new ToolResultEvictionContext({
    contextLimit: 1000,
    atFraction: 0.5,
    keepRecentRounds: 1,
    clearAtLeast: 1,
    minResultTokens: 1
  });
  const msgs = transcript(3);
  const out = engine.prepare(msgs, ctx(600));
  expect(out).toHaveLength(msgs.length); // nothing removed
  expect(out.map((m) => m.role)).toEqual(msgs.map((m) => m.role));
  for (let i = 0; i < msgs.length; i++) {
    const before = msgs[i]?.content;
    const after = out[i]?.content;
    if (Array.isArray(before) && before[0]?.type === 'tool-call') {
      expect(after).toEqual(before); // tool-call (assistant) messages untouched
    }
  }
});

test('does not fire when reclaimable tokens are below clearAtLeast', () => {
  const engine = new ToolResultEvictionContext({
    contextLimit: 1000,
    atFraction: 0.5,
    keepRecentRounds: 1,
    clearAtLeast: 100_000,
    minResultTokens: 1
  });
  const msgs = transcript(4);
  const out = engine.prepare(msgs, ctx(600));
  expect(out).toBe(msgs); // above trigger, but not enough to reclaim → untouched
});

test('skips results smaller than minResultTokens', () => {
  const engine = new ToolResultEvictionContext({
    contextLimit: 1000,
    atFraction: 0.5,
    keepRecentRounds: 1,
    clearAtLeast: 1,
    minResultTokens: 100 // ~400 chars; our small results are tiny
  });
  const msgs: ModelMessage[] = [
    sys('s'),
    call('t0', 'ls', {}),
    result('t0', 'ls', 'a.ts b.ts'),
    call('t1', 'ls', {}),
    result('t1', 'ls', 'c.ts'),
    user('go')
  ];
  const out = engine.prepare(msgs, ctx(600));
  expect(out).toBe(msgs); // nothing large enough to bother
});

test('prefers lastRealInputTokens over the estimate for the trigger gate', () => {
  const engine = new ToolResultEvictionContext({
    contextLimit: 1000,
    atFraction: 0.5,
    keepRecentRounds: 1,
    clearAtLeast: 1,
    minResultTokens: 1
  });
  const msgs = transcript(6); // estimate alone would be well above trigger
  // Real count says the window is nearly empty → gate stays shut despite a large estimate.
  const out = engine.prepare(msgs, ctx(50));
  expect(out).toBe(msgs);
});

test('falls back to the estimate when lastRealInputTokens is absent', () => {
  const engine = new ToolResultEvictionContext({
    contextLimit: 1000,
    atFraction: 0.5,
    keepRecentRounds: 1,
    clearAtLeast: 1,
    minResultTokens: 1
  });
  // No lastRealInputTokens: 6 rounds × ~200 tokens ≈ 1200 est > trigger(500) → eviction fires.
  const msgs = transcript(6);
  const out = engine.prepare(msgs, ctx());
  expect(out).not.toBe(msgs);
  expect(outputs(out).some((o) => o.startsWith(EVICTED_MARKER))).toBe(true);
});

test('is idempotent — already-evicted rounds are not re-evicted or double-marked', () => {
  const engine = new ToolResultEvictionContext({
    contextLimit: 1000,
    atFraction: 0.5,
    keepRecentRounds: 2,
    clearAtLeast: 1,
    minResultTokens: 1
  });
  const msgs = transcript(5);
  const once = engine.prepare(msgs, ctx(600));
  const twice = engine.prepare(once, ctx(600));
  expect(twice).toBe(once); // second pass finds nothing new → same reference
  for (const o of outputs(twice).filter((o) => o.startsWith(EVICTED_MARKER))) {
    expect(o.match(new RegExp(EVICTED_MARKER.replace(/[[\]]/g, '\\$&'), 'g')) ?? []).toHaveLength(1);
  }
});

test('does not mutate the original message objects (durable history stays intact)', () => {
  const engine = new ToolResultEvictionContext({
    contextLimit: 1000,
    atFraction: 0.5,
    keepRecentRounds: 1,
    clearAtLeast: 1,
    minResultTokens: 1
  });
  const msgs = transcript(4);
  const originalOutputs = outputs(msgs);
  engine.prepare(msgs, ctx(600));
  expect(outputs(msgs)).toEqual(originalOutputs);
});

test('spills each evicted result to persistRawOutput before overwriting it, keyed by toolCallId', () => {
  const spilled: Array<{ sessionId: string; toolCallId: string; output: string }> = [];
  const engine = new ToolResultEvictionContext({
    contextLimit: 1000,
    atFraction: 0.5,
    keepRecentRounds: 1,
    clearAtLeast: 1,
    minResultTokens: 1,
    persistRawOutput: (sessionId, toolCallId, output) => spilled.push({ sessionId, toolCallId, output })
  });
  const msgs = transcript(4); // toolCallIds t0..t3, one per round
  engine.prepare(msgs, ctx(600));

  // 3 of 4 rounds evicted (keepRecentRounds=1): t0, t1, t2.
  expect(spilled.map((s) => s.toolCallId).sort()).toEqual(['t0', 't1', 't2']);
  expect(spilled.every((s) => s.sessionId === 'ses_x00000000000')).toBe(true);
  // The spilled bytes are the ORIGINAL output, not the placeholder.
  expect(spilled.find((s) => s.toolCallId === 't0')?.output.startsWith('OUT0')).toBe(true);
});

test('the eviction placeholder points at read_tool_output with the handle when spilling is configured', () => {
  const engine = new ToolResultEvictionContext({
    contextLimit: 1000,
    atFraction: 0.5,
    keepRecentRounds: 1,
    clearAtLeast: 1,
    minResultTokens: 1,
    persistRawOutput: () => {}
  });
  const msgs = transcript(3);
  const out = engine.prepare(msgs, ctx(600));
  const evicted = outputs(out).filter((o) => o.startsWith(EVICTED_MARKER));
  expect(evicted.length).toBeGreaterThan(0);
  for (const o of evicted) expect(o).toContain('read_tool_output');
});

test('without persistRawOutput configured, the placeholder falls back to the re-run hint (no dangling handle promise)', () => {
  const engine = new ToolResultEvictionContext({
    contextLimit: 1000,
    atFraction: 0.5,
    keepRecentRounds: 1,
    clearAtLeast: 1,
    minResultTokens: 1
  });
  const msgs = transcript(3);
  const out = engine.prepare(msgs, ctx(600));
  const evicted = outputs(out).filter((o) => o.startsWith(EVICTED_MARKER));
  expect(evicted.length).toBeGreaterThan(0);
  for (const o of evicted) {
    expect(o).not.toContain('read_tool_output');
    expect(o).toContain('Call the tool again');
  }
});

test('does not spill when prepare() is called with no ctx (no session to key the spill by)', () => {
  const spilled: unknown[] = [];
  const engine = new ToolResultEvictionContext({
    contextLimit: 1000,
    // Tiny trigger so this fires regardless of the shared globalEstimator's calibrated ratio (no
    // ctx here means no per-test estimator override, per ctx?.estimator ?? globalEstimator).
    atFraction: 0.001,
    keepRecentRounds: 1,
    clearAtLeast: 1,
    minResultTokens: 1,
    persistRawOutput: (...args) => spilled.push(args)
  });
  const msgs = transcript(3);
  const out = engine.prepare(msgs); // ctx omitted entirely → ctx?.sessionId is undefined
  expect(spilled).toHaveLength(0);
  // The placeholder must not promise a handle that was never spilled — a model calling
  // read_tool_output for it would always get "not found" for bytes that are gone for good.
  for (const o of outputs(out).filter((o) => o.startsWith(EVICTED_MARKER))) {
    expect(o).not.toContain('read_tool_output');
    expect(o).toContain('Call the tool again');
  }
});

test('reclaimedTokens accumulates across multiple firings for the same session', () => {
  const engine = new ToolResultEvictionContext({
    contextLimit: 1000,
    atFraction: 0.5,
    keepRecentRounds: 1,
    clearAtLeast: 1,
    minResultTokens: 1
  });
  expect(engine.reclaimedTokens('ses_x00000000000')).toBe(0);
  const once = engine.prepare(transcript(4), ctx(600));
  const firstTotal = engine.reclaimedTokens('ses_x00000000000');
  expect(firstTotal).toBeGreaterThan(0);
  // A second pass over a fresh (unevicted) transcript reclaims more and adds to the running total.
  engine.prepare(transcript(4), ctx(600));
  expect(engine.reclaimedTokens('ses_x00000000000')).toBeGreaterThan(firstTotal);
  // A no-op pass (already evicted, nothing left to reclaim) leaves the total unchanged.
  engine.prepare(once, ctx(600));
  expect(engine.reclaimedTokens('ses_x00000000000')).toBeGreaterThan(firstTotal);
});

test('reclaimedTokens stays 0 for a session that never triggered eviction', () => {
  const engine = new ToolResultEvictionContext({ contextLimit: 1_000_000, atFraction: 0.99 });
  engine.prepare(transcript(4), ctx(600));
  expect(engine.reclaimedTokens('ses_x00000000000')).toBe(0);
});

test('emits a context.evicted notice with the reclaimed total and result count when eviction fires', () => {
  const events: Array<{ type: string; payload: unknown }> = [];
  const engine = new ToolResultEvictionContext({
    contextLimit: 1000,
    atFraction: 0.5,
    keepRecentRounds: 1,
    clearAtLeast: 1,
    minResultTokens: 1
  });
  const emittingCtx: ContextPrepareCtx = {
    sessionId: 'ses_x00000000000',
    emit: (e) => events.push(e),
    estimator: est()
  };
  engine.prepare(transcript(5), emittingCtx); // keepRecentRounds=1 → 4 of 5 rounds evicted
  const notice = events.find((e) => e.type === 'context.evicted');
  expect(notice?.payload).toEqual({ reclaimedTokens: engine.reclaimedTokens('ses_x00000000000'), resultCount: 4 });
});

test('does not emit context.evicted when nothing fires', () => {
  const events: Array<{ type: string }> = [];
  const engine = new ToolResultEvictionContext({ contextLimit: 1_000_000, atFraction: 0.99 });
  engine.prepare(transcript(4), { sessionId: 'ses_x00000000000', emit: (e) => events.push(e), estimator: est() });
  expect(events.some((e) => e.type === 'context.evicted')).toBe(false);
});
