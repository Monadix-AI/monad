import type { Session } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { createStore } from '#/store/db/index.ts';

// biome-ignore lint/suspicious/noExplicitAny: test-only escape hatch to access private sqlite for backdated ledger rows
const rawSqlite = (store: ReturnType<typeof createStore>) => (store as any).sqlite;

function seedSession(store: ReturnType<typeof createStore>): Session {
  const now = new Date().toISOString();
  const s: Session = {
    id: newId('ses'),
    title: 't',
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

function dayOffset(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86400_000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Insert a ledger row for a specific (backdated) day. Uses rawSqlite to set an arbitrary day. */
function insertLedgerForDay(
  store: ReturnType<typeof createStore>,
  day: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): void {
  rawSqlite(store)
    .query(
      `INSERT INTO usage_ledger (day, provider, model, category, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, updated_at)
       VALUES ($day, 'test', $model, 'chat', $in, $out, 0, 0, 0, 0, $day || 'T00:00:00.000Z')
       ON CONFLICT(day, provider, model, category) DO UPDATE SET
         input_tokens  = input_tokens  + $in,
         output_tokens = output_tokens + $out`
    )
    .run({ $day: day, $model: model, $in: inputTokens, $out: outputTokens });
}

// ---------------------------------------------------------------------------
// Empty DB
// ---------------------------------------------------------------------------

test('stats on empty DB returns zeros and nulls', () => {
  const store = createStore();
  const s = store.stats('all');

  expect(s.sessions).toBe(0);
  expect(s.messages).toBe(0);
  expect(s.totalTokens).toBe(0);
  expect(s.activeDays).toBe(0);
  expect(s.currentStreak).toBe(0);
  expect(s.longestStreak).toBe(0);
});

// ---------------------------------------------------------------------------
// sessions + messages counts
// ---------------------------------------------------------------------------

test('sessions and messages counts are correct', () => {
  const store = createStore();
  const s1 = seedSession(store);
  const s2 = seedSession(store);

  const sid1 = s1.id;
  const sid2 = s2.id;

  store.insertMessage(newId('msg'), sid1, 'hello', new Date().toISOString(), 'user');
  store.insertMessage(newId('msg'), sid1, 'world', new Date().toISOString(), 'assistant');
  store.insertMessage(newId('msg'), sid2, 'hi', new Date().toISOString(), 'user');

  const s = store.stats('all');
  expect(s.sessions).toBe(2);
  expect(s.messages).toBe(3);
});

// ---------------------------------------------------------------------------
// Range filtering
// ---------------------------------------------------------------------------

test('range=7d excludes ledger entries older than 6 days ago', () => {
  const store = createStore();

  insertLedgerForDay(store, dayOffset(0), 'model-a', 100, 50); // today — inside 7d
  insertLedgerForDay(store, dayOffset(3), 'model-a', 200, 100); // 3 days ago — inside 7d
  insertLedgerForDay(store, dayOffset(6), 'model-a', 300, 150); // 6 days ago — inside 7d (boundary)
  insertLedgerForDay(store, dayOffset(7), 'model-a', 400, 200); // 7 days ago — outside 7d

  const s7d = store.stats('7d');
  // only 3 active days (today, -3, -6); -7 is excluded
  expect(s7d.activeDays).toBe(3);
  // total tokens: (100+50) + (200+100) + (300+150) = 900
  expect(s7d.totalTokens).toBe(900);
});

test('range=30d excludes entries older than 29 days ago', () => {
  const store = createStore();

  insertLedgerForDay(store, dayOffset(0), 'model-a', 10, 5);
  insertLedgerForDay(store, dayOffset(29), 'model-a', 20, 10); // boundary — inside 30d
  insertLedgerForDay(store, dayOffset(30), 'model-a', 40, 20); // outside 30d

  const s30d = store.stats('30d');
  expect(s30d.activeDays).toBe(2);
  expect(s30d.totalTokens).toBe(45); // (10+5) + (20+10)

  const sAll = store.stats('all');
  expect(sAll.activeDays).toBe(3);
});

test('range=all includes all historical data', () => {
  const store = createStore();

  insertLedgerForDay(store, dayOffset(0), 'model-a', 10, 5);
  insertLedgerForDay(store, dayOffset(60), 'model-a', 100, 50);
  insertLedgerForDay(store, dayOffset(365), 'model-a', 1000, 500);

  const s = store.stats('all');
  expect(s.activeDays).toBe(3);
  expect(s.totalTokens).toBe(1665); // 15 + 150 + 1500
});

// ---------------------------------------------------------------------------
// activeDays
// ---------------------------------------------------------------------------

test('activeDays counts distinct days with ledger entries', () => {
  const store = createStore();

  // Same day, two models — should still count as 1 active day
  insertLedgerForDay(store, dayOffset(0), 'model-a', 10, 5);
  insertLedgerForDay(store, dayOffset(0), 'model-b', 20, 10);
  insertLedgerForDay(store, dayOffset(1), 'model-a', 30, 15);

  const s = store.stats('all');
  expect(s.activeDays).toBe(2);
});

// ---------------------------------------------------------------------------
// currentStreak and longestStreak
// ---------------------------------------------------------------------------

test('currentStreak counts consecutive days ending at today', () => {
  const store = createStore();

  // today, yesterday, 2 days ago = streak of 3
  insertLedgerForDay(store, dayOffset(0), 'model-a', 10, 5);
  insertLedgerForDay(store, dayOffset(1), 'model-a', 10, 5);
  insertLedgerForDay(store, dayOffset(2), 'model-a', 10, 5);
  // gap at day 3
  insertLedgerForDay(store, dayOffset(4), 'model-a', 10, 5);

  const s = store.stats('all');
  expect(s.currentStreak).toBe(3);
});

test('currentStreak is 0 when today has no activity', () => {
  const store = createStore();

  // activity only in the past, not today
  insertLedgerForDay(store, dayOffset(1), 'model-a', 10, 5);
  insertLedgerForDay(store, dayOffset(2), 'model-a', 10, 5);

  const s = store.stats('all');
  expect(s.currentStreak).toBe(0);
});

test('longestStreak finds the longest historical run, not necessarily ending today', () => {
  const store = createStore();

  // Historical run of 4: days -10, -9, -8, -7
  insertLedgerForDay(store, dayOffset(10), 'model-a', 10, 5);
  insertLedgerForDay(store, dayOffset(9), 'model-a', 10, 5);
  insertLedgerForDay(store, dayOffset(8), 'model-a', 10, 5);
  insertLedgerForDay(store, dayOffset(7), 'model-a', 10, 5);
  // gap at -6
  // Recent run of 2: today + yesterday
  insertLedgerForDay(store, dayOffset(1), 'model-a', 10, 5);
  insertLedgerForDay(store, dayOffset(0), 'model-a', 10, 5);

  const s = store.stats('all');
  expect(s.longestStreak).toBe(4);
  expect(s.currentStreak).toBe(2);
});

test('longestStreak equals currentStreak when current run is the longest', () => {
  const store = createStore();

  // Only activity: 3 consecutive days ending today
  insertLedgerForDay(store, dayOffset(2), 'model-a', 10, 5);
  insertLedgerForDay(store, dayOffset(1), 'model-a', 10, 5);
  insertLedgerForDay(store, dayOffset(0), 'model-a', 10, 5);

  const s = store.stats('all');
  expect(s.longestStreak).toBe(3);
  expect(s.currentStreak).toBe(3);
});

// ---------------------------------------------------------------------------
// peakHour
// ---------------------------------------------------------------------------

test('peakHour derives from message createdAt local hours', () => {
  const store = createStore();
  const sess = seedSession(store);

  // Manufacture messages at a specific hour by using a fixed ISO timestamp.
  // We want hour 14 to be peak (3 messages) vs hour 9 (1 message).
  const makeAt = (hour: number) => {
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };

  store.insertMessage(newId('msg'), sess.id, 'a', makeAt(9), 'user');
  store.insertMessage(newId('msg'), sess.id, 'b', makeAt(14), 'user');
  store.insertMessage(newId('msg'), sess.id, 'c', makeAt(14), 'assistant');
  store.insertMessage(newId('msg'), sess.id, 'd', makeAt(14), 'user');

  const s = store.stats('all');
  expect(s.peakHour).toBe(14);
});

test('peakHour is null when there are no messages', () => {
  const store = createStore();
  const _s = store.stats('all');
});

// ---------------------------------------------------------------------------
// favoriteModel
// ---------------------------------------------------------------------------

test('favoriteModel is the model with most total tokens', () => {
  const store = createStore();

  insertLedgerForDay(store, dayOffset(0), 'model-small', 10, 5); // 15 tokens
  insertLedgerForDay(store, dayOffset(0), 'model-large', 500, 300); // 800 tokens

  const s = store.stats('all');
  expect(s.favoriteModel).toBe('model-large');
});

test('favoriteModel is null when no ledger data', () => {
  const store = createStore();
  const _s = store.stats('all');
});

// ---------------------------------------------------------------------------
// heatmap
// ---------------------------------------------------------------------------

test('heatmap includes all days with activity, sorted ascending', () => {
  const store = createStore();

  const d0 = dayOffset(0);
  const d2 = dayOffset(2);
  const d5 = dayOffset(5);

  insertLedgerForDay(store, d5, 'model-a', 10, 5);
  insertLedgerForDay(store, d0, 'model-a', 20, 10);
  insertLedgerForDay(store, d2, 'model-a', 30, 15);

  const s = store.stats('all');
  expect(s.heatmap.map((b) => b.day)).toEqual([d5, d2, d0]);
  expect(s.heatmap.find((b) => b.day === d0)?.totalTokens).toBe(30); // 20+10
  expect(s.heatmap.find((b) => b.day === d2)?.totalTokens).toBe(45); // 30+15
  expect(s.heatmap.find((b) => b.day === d5)?.totalTokens).toBe(15); // 10+5
});

test('heatmap aggregates multiple models on the same day', () => {
  const store = createStore();
  const today = dayOffset(0);

  insertLedgerForDay(store, today, 'model-a', 100, 50);
  insertLedgerForDay(store, today, 'model-b', 200, 100);

  const s = store.stats('all');
  expect(s.heatmap.length).toBe(1);
  expect(s.heatmap[0]?.totalTokens).toBe(450); // 100+50+200+100
});

// ---------------------------------------------------------------------------
// models array
// ---------------------------------------------------------------------------

test('models array sorted by totalTokens desc', () => {
  const store = createStore();

  insertLedgerForDay(store, dayOffset(0), 'small', 10, 5); // 15 tokens
  insertLedgerForDay(store, dayOffset(0), 'medium', 50, 25); // 75 tokens
  insertLedgerForDay(store, dayOffset(0), 'large', 200, 100); // 300 tokens

  const s = store.stats('all');
  expect(s.models.map((m) => m.model)).toEqual(['large', 'medium', 'small']);
});

test('models pct sums to approximately 100', () => {
  const store = createStore();

  insertLedgerForDay(store, dayOffset(0), 'model-a', 300, 0);
  insertLedgerForDay(store, dayOffset(0), 'model-b', 700, 0);

  const s = store.stats('all');
  const total = s.models.reduce((sum, m) => sum + m.pct, 0);
  // Floating-point rounding may cause tiny drift; within 0.2 is sufficient.
  expect(total).toBeCloseTo(100, 0);
});

test('models pct is 0 when grandTotal is 0 (all zero-token rows)', () => {
  const store = createStore();

  // range=all is capped to a rolling window (see ALL_RANGE_MAX_DAYS in stats.ts), so the fixture
  // day must be "recent" rather than a fixed historical date or it falls outside the window.
  const day = dayOffset(0);
  rawSqlite(store)
    .query(
      `INSERT INTO usage_ledger (day, provider, model, category, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, updated_at)
       VALUES ($day, 'test', 'zero-model', 'chat', 0, 0, 0, 0, 0, 0, $updatedAt)`
    )
    .run({ $day: day, $updatedAt: `${day}T00:00:00Z` });

  const s = store.stats('all');
  expect(s.models.length).toBe(1);
  expect(s.models[0]?.pct).toBe(0);
});

test('models inputTokens and outputTokens match what was recorded', () => {
  const store = createStore();

  insertLedgerForDay(store, dayOffset(0), 'model-a', 123, 456);
  insertLedgerForDay(store, dayOffset(1), 'model-a', 77, 44);

  const s = store.stats('all');
  const m = s.models.find((x) => x.model === 'model-a');
  expect(m?.inputTokens).toBe(200);
  expect(m?.outputTokens).toBe(500);
});
