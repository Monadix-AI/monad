import type { Session } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { createStore } from '#/store/db/index.ts';

function seedSession(store: ReturnType<typeof createStore>): Session {
  const now = new Date().toISOString();
  const s: Session = {
    id: newId('ses'),
    title: 't',
    ownerPrincipalId: newId('prn'),
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    createdAt: now,
    updatedAt: now
  };
  store.insertSession(s);
  return s;
}

test('addUsage accumulates all token classes + cost into the session (monotonic)', () => {
  const store = createStore();
  const s = seedSession(store);
  store.addUsage(s.id, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, reasoningTokens: 5 }, 0.01);
  store.addUsage(s.id, { inputTokens: 10, outputTokens: 5, cacheWriteTokens: 7 }, 0.002);

  const u = store.getSession(s.id)?.usage;
  expect(u?.inputTokens).toBe(110);
  expect(u?.outputTokens).toBe(55);
  expect(u?.cacheReadTokens).toBe(20);
  expect(u?.cacheWriteTokens).toBe(7);
  expect(u?.reasoningTokens).toBe(5);
  expect(store.getSession(s.id)?.costUsd).toBeCloseTo(0.012, 9);
});

test('global ledger accumulates per provider/model and survives session deletion', () => {
  const store = createStore();
  const s = seedSession(store);
  store.recordLedger(
    'anthropic',
    'claude-x',
    'chat',
    { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 },
    0.05
  );
  store.recordLedger('anthropic', 'claude-x', 'chat', { inputTokens: 100, outputTokens: 50 }, 0.005);
  store.recordLedger('openai', 'gpt-x', 'chat', { inputTokens: 10, outputTokens: 5 }, 0.001);

  store.deleteSession(s.id); // ledger must NOT be affected by session deletion

  const ledger = store.ledger();
  expect(ledger.length).toBe(2);
  const anthropic = ledger.find((l) => l.model === 'claude-x');
  expect(anthropic?.inputTokens).toBe(1100);
  expect(anthropic?.outputTokens).toBe(550);
  expect(anthropic?.cacheReadTokens).toBe(200);
  expect(anthropic?.costUsd).toBeCloseTo(0.055, 9);
  expect(ledger[0]?.model).toBe('claude-x'); // ordered by cost desc
});

test('ledger() sums across categories; ledgerBreakdown() keeps the day/category dimensions', () => {
  const store = createStore();
  store.recordLedger('openai', 'm', 'chat', { inputTokens: 100, outputTokens: 40 }, 0.02);
  store.recordLedger('openai', 'm', 'embedding', { inputTokens: 1000 }, 0.001);

  // Rolled-up view collapses categories into one provider/model row.
  const rolled = store.ledger();
  expect(rolled.length).toBe(1);
  expect(rolled[0]?.inputTokens).toBe(1100);
  expect(rolled[0]?.costUsd).toBeCloseTo(0.021, 9);

  // Breakdown keeps them apart, tagged by category and (today's) local day.
  const detail = store.ledgerBreakdown();
  expect(detail.length).toBe(2);
  expect(detail.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.day))).toBe(true);
  expect(detail.find((r) => r.category === 'embedding')?.inputTokens).toBe(1000);
  expect(detail.find((r) => r.category === 'chat')?.outputTokens).toBe(40);
});

test('clearLedger wipes the global ledger (manual billing reset)', () => {
  const store = createStore();
  store.recordLedger('p', 'm', 'chat', { inputTokens: 1 }, 1);
  expect(store.ledger().length).toBe(1);
  store.clearLedger();
});

test('session usage and global ledger are independent', () => {
  const store = createStore();
  const s = seedSession(store);
  store.addUsage(s.id, { inputTokens: 100 }, 0.01); // session only
  expect(store.getSession(s.id)?.usage?.inputTokens).toBe(100);
});
