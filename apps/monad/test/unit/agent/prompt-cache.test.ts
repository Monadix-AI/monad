import type { ChatMessage } from '#/agent/index.ts';

import { expect, test } from 'bun:test';

import { PromptReplayCache, replayHistory } from '#/agent/index.ts';

function msg(id: string, text: string, role: ChatMessage['role'] = 'user'): ChatMessage {
  return { id, sessionId: 'ses_1', role, text, createdAt: '2026-01-01T00:00:00Z' };
}

test('replayHistory excludes directive (slash-command) turns from the model prompt', () => {
  const history: ChatMessage[] = [
    msg('m1', 'hello'),
    { ...msg('m2', '/reset', 'user'), type: 'directive' },
    { ...msg('m3', '🧹 Cleared 3 messages.', 'assistant'), type: 'directive' },
    msg('m4', 'after the command', 'assistant')
  ];
  const replayed = replayHistory(history);
  // Only the two real turns survive — the command echo + directive reply are dropped, so they
  // never reach the model, never count toward tokens/billing, and are never summarized.
  expect(replayed.map((m) => m.content)).toEqual(['hello', 'after the command']);
});

test('returns the same array reference on a cache hit (identical history)', () => {
  const cache = new PromptReplayCache();
  const history = [msg('m1', 'hello'), msg('m2', 'world', 'assistant')];

  const first = cache.replay('ses_1', history);
  const second = cache.replay('ses_1', history);
  expect(second).toBe(first); // reused → no re-replay, and ModelMessage identity preserved
  expect(first).toEqual(replayHistory(history)); // and correct
});

test('rebuilds when a message is appended (length + lastId change)', () => {
  const cache = new PromptReplayCache();
  const h1 = [msg('m1', 'hi')];
  const a = cache.replay('ses_1', h1);

  const h2 = [...h1, msg('m2', 'there', 'assistant')];
  const b = cache.replay('ses_1', h2);
  expect(b).not.toBe(a);
  expect(b.length).toBe(2);
  expect(b).toEqual(replayHistory(h2));
});

test('rebuilds when history is rewound (shorter, different lastId)', () => {
  const cache = new PromptReplayCache();
  const full = [msg('m1', 'a'), msg('m2', 'b'), msg('m3', 'c')];
  cache.replay('ses_1', full);

  const rewound = [msg('m1', 'a'), msg('m2', 'b')]; // m3 deactivated → list() drops it
  const out = cache.replay('ses_1', rewound);
  expect(out.length).toBe(1);
  expect(out).toEqual(replayHistory(rewound));
});

test('caches sessions independently', () => {
  const cache = new PromptReplayCache();
  const a = cache.replay('ses_a', [msg('a1', 'x')]);
  const b = cache.replay('ses_b', [msg('b1', 'y')]);
  expect(cache.replay('ses_a', [msg('a1', 'x')])).toBe(a);
  expect(cache.replay('ses_b', [msg('b1', 'y')])).toBe(b);
});

test('evicts the least-recently-used session past the cap', () => {
  const cache = new PromptReplayCache(2); // hold at most 2 sessions
  const a = cache.replay('s_a', [msg('a', '1')]);
  cache.replay('s_b', [msg('b', '1')]);
  cache.replay('s_a', [msg('a', '1')]); // touch s_a → s_b is now LRU
  cache.replay('s_c', [msg('c', '1')]); // inserts s_c → evicts s_b (oldest)

  // s_a survived (re-replay is still a hit, same reference)…
  expect(cache.replay('s_a', [msg('a', '1')])).toBe(a);
  // …s_b was evicted, so it rebuilds (new reference each call after eviction)
  const b1 = cache.replay('s_b', [msg('b', '1')]);
  const b2 = cache.replay('s_b', [msg('b', '1')]);
  expect(b2).toBe(b1); // re-cached now
});

test('replayHistory skips orphaned user message when generation failed with no assistant output', () => {
  // Simulates: user sends a message, generation fails before any token is produced,
  // user retries. The first user message must be excluded from context so the model
  // doesn't receive two consecutive user messages (providers require alternating roles).
  const history: ChatMessage[] = [
    msg('m1', 'prior question'),
    msg('m2', 'prior answer', 'assistant'),
    msg('m3', 'failing question'),
    { ...msg('m4', '[503] upstream error', 'assistant'), type: 'error' },
    msg('m5', 'retry question')
  ];
  const out = replayHistory(history);
  // The orphaned user message (m3) and its error row (m4) must not reach the model.
  // The retry user message (m5) IS included — no doubled user turns.
  expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  expect(out.map((m) => m.content)).toEqual(['prior question', 'prior answer', 'retry question']);
});

test('replayHistory keeps user message when tool steps were persisted before the error', () => {
  // If any tool step was already persisted (partial turn), the user message is NOT
  // orphaned — a real assistant interaction happened, so it stays in context.
  const tc = { toolCallId: 'tc_1', toolName: 'search', input: { q: 'x' } };
  const history: ChatMessage[] = [
    msg('m1', 'do complex task'),
    msg('m2', 'Let me check.', 'assistant'),
    { ...msg('m3', JSON.stringify(tc), 'assistant'), type: 'tool_call', data: tc },
    { ...msg('m4', 'result', 'tool'), type: 'tool_result', data: { ...tc, output: 'result' } },
    { ...msg('m5', '[503] error', 'assistant'), type: 'error' },
    msg('m6', 'retry')
  ];
  const out = replayHistory(history);
  // user → assistant (preamble+tool call coalesced) → tool → user (retry). No role violations.
  expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
  expect(out[0]?.content).toBe('do complex task');
  expect(out[3]?.content).toBe('retry');
});

test('replayHistory coalesces a per-segment turn (preamble text + tool_call) into one assistant message', () => {
  const tc = { toolCallId: 'tc_1', toolName: 'search', input: { q: 'x' } };
  const history: ChatMessage[] = [
    msg('m1', 'go', 'user'),
    // Per-segment: the preamble text and the tool call persist as SEPARATE assistant rows.
    msg('m2', 'Let me check.', 'assistant'),
    { ...msg('m3', JSON.stringify(tc), 'assistant'), type: 'tool_call', data: tc },
    { ...msg('m4', 'result', 'tool'), type: 'tool_result', data: { ...tc, output: 'result' } },
    msg('m5', 'The answer.', 'assistant')
  ];
  const out = replayHistory(history);

  // No two adjacent assistant messages (providers like Anthropic require alternating roles).
  for (let i = 1; i < out.length; i++) {
    expect(out[i]?.role === 'assistant' && out[i - 1]?.role === 'assistant').toBe(false);
  }
  expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  // The preamble text and the tool-call are merged into ONE assistant message's blocks.
  const a = out[1];
  expect(Array.isArray(a?.content)).toBe(true);
  const blocks = a?.content as { type: string; text?: string; toolName?: string }[];
  expect(blocks[0]).toMatchObject({ type: 'text', text: 'Let me check.' });
  expect(blocks[1]).toMatchObject({ type: 'tool-call', toolName: 'search' });
  expect(out[3]?.content).toBe('The answer.');
});
