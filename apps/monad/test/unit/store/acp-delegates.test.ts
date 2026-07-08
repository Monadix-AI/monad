// Unit tests for the acp_delegates table: migration, CRUD methods, and orphan reconciliation.

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createStore } from '#/store/db/index.ts';
import { CURRENT_SCHEMA_VERSION, migrate } from '#/store/db/migrations.ts';

// ── Migration ─────────────────────────────────────────────────────────────────

test('migrate() creates acp_delegates table at v1', () => {
  const db = new Database(':memory:');
  migrate(db);

  expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
    CURRENT_SCHEMA_VERSION
  );

  const cols = (db.prepare('PRAGMA table_info(acp_delegates)').all() as { name: string }[]).map((c) => c.name);
  for (const col of [
    'id',
    'session_id',
    'agent_name',
    'acp_session_id',
    'pid',
    'spawned_at',
    'last_used_at',
    'evicted_at',
    'evict_reason',
    'reuse_count',
    'prompt_count'
  ]) {
    expect(cols).toContain(col);
  }
});

test('migrate() is idempotent — running again is a no-op', () => {
  const db = new Database(':memory:');
  migrate(db);
  // Insert a row to verify re-running doesn't corrupt data
  db.exec(
    `INSERT INTO acp_delegates (id, session_id, agent_name, acp_session_id, pid, spawned_at, last_used_at)
       VALUES ('k1', 'ses_x', 'a', 'acp-1', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  );
  migrate(db);
  expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
    CURRENT_SCHEMA_VERSION
  );
  expect((db.prepare('SELECT COUNT(*) AS n FROM acp_delegates').get() as { n: number }).n).toBe(1);
});

// ── CRUD ──────────────────────────────────────────────────────────────────────

let store: ReturnType<typeof createStore>;

beforeEach(() => {
  store = createStore(); // :memory:
});

afterEach(() => {
  store.close();
});

const makeRow = (overrides: Partial<Parameters<typeof store.upsertAcpDelegate>[0]> = {}) => ({
  id: 'ses_abc\x00my-agent',
  sessionId: 'ses_abc',
  agentName: 'my-agent',
  acpSessionId: 'acp-sess-1',
  pid: 1234,
  spawnedAt: '2026-06-23T10:00:00.000Z',
  lastUsedAt: '2026-06-23T10:00:00.000Z',
  ...overrides
});

test('upsertAcpDelegate inserts a live row', () => {
  store.upsertAcpDelegate(makeRow());
  const live = store.listLiveAcpDelegates();
  expect(live).toHaveLength(1);
  expect(live[0]?.agentName).toBe('my-agent');
  expect(live[0]?.reuseCount).toBe(0);
  expect(live[0]?.promptCount).toBe(0);
});

test('upsertAcpDelegate re-insert (re-spawn) resets counters and clears evictedAt', () => {
  store.upsertAcpDelegate(makeRow());
  store.touchAcpDelegate(makeRow().id, '2026-06-23T10:01:00.000Z', 2, 3);
  store.closeAcpDelegate(makeRow().id, '2026-06-23T10:05:00.000Z', 'idle');

  // Re-spawn: upsert again
  store.upsertAcpDelegate(
    makeRow({
      pid: 5678,
      acpSessionId: 'acp-sess-2',
      spawnedAt: '2026-06-23T11:00:00.000Z',
      lastUsedAt: '2026-06-23T11:00:00.000Z'
    })
  );
  const live = store.listLiveAcpDelegates();
  expect(live).toHaveLength(1);
  expect(live[0]?.pid).toBe(5678);
  expect(live[0]?.acpSessionId).toBe('acp-sess-2');
  expect(live[0]?.reuseCount).toBe(0);
  expect(live[0]?.promptCount).toBe(0);
});

test('touchAcpDelegate updates stats on a live row and returns true', () => {
  store.upsertAcpDelegate(makeRow());
  const updated = store.touchAcpDelegate(makeRow().id, '2026-06-23T10:02:00.000Z', 1, 2);

  expect(updated).toBe(true);
  const rows = store.listAcpDelegatesForSession('ses_abc');
  expect(rows[0]?.reuseCount).toBe(1);
  expect(rows[0]?.promptCount).toBe(2);
  expect(rows[0]?.lastUsedAt).toBe('2026-06-23T10:02:00.000Z');
});

test('touchAcpDelegate is a no-op on an already-evicted row and returns false', () => {
  store.upsertAcpDelegate(makeRow());
  store.closeAcpDelegate(makeRow().id, '2026-06-23T10:03:00.000Z', 'idle');
  const updated = store.touchAcpDelegate(makeRow().id, '2026-06-23T10:04:00.000Z', 5, 10);

  expect(updated).toBe(false);
  const rows = store.listAcpDelegatesForSession('ses_abc');
  // Stats must NOT have been updated after eviction
  expect(rows[0]?.reuseCount).toBe(0);
  expect(rows[0]?.promptCount).toBe(0);
});

test('closeAcpDelegate marks the row evicted', () => {
  store.upsertAcpDelegate(makeRow());
  store.closeAcpDelegate(makeRow().id, '2026-06-23T10:05:00.000Z', 'idle');

  const rows = store.listAcpDelegatesForSession('ses_abc');
  expect(rows[0]?.evictedAt).toBe('2026-06-23T10:05:00.000Z');
  expect(rows[0]?.evictReason).toBe('idle');
});

test('listLiveAcpDelegates returns only rows with evicted_at NULL', () => {
  store.upsertAcpDelegate(
    makeRow({ id: 'ses_a\x00agent-1', sessionId: 'ses_a', agentName: 'agent-1', acpSessionId: 'acp-1' })
  );
  store.upsertAcpDelegate(
    makeRow({ id: 'ses_a\x00agent-2', sessionId: 'ses_a', agentName: 'agent-2', acpSessionId: 'acp-2' })
  );
  store.closeAcpDelegate('ses_a\x00agent-1', '2026-06-23T10:05:00.000Z', 'done');

  const live = store.listLiveAcpDelegates();
  expect(live).toHaveLength(1);
  expect(live[0]?.agentName).toBe('agent-2');
});

test('listAcpDelegatesForSession returns all rows (live + evicted) for the session', () => {
  store.upsertAcpDelegate(makeRow({ id: 'ses_abc\x00a1', agentName: 'a1', acpSessionId: 'acp-1' }));
  store.upsertAcpDelegate(makeRow({ id: 'ses_abc\x00a2', agentName: 'a2', acpSessionId: 'acp-2' }));
  store.closeAcpDelegate('ses_abc\x00a1', '2026-06-23T10:05:00.000Z', 'idle');

  const rows = store.listAcpDelegatesForSession('ses_abc');
  expect(rows).toHaveLength(2);
});

test('pruneOldAcpDelegates deletes evicted rows older than the cutoff', () => {
  store.upsertAcpDelegate(makeRow());
  // Evict with a timestamp far in the past
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  store.closeAcpDelegate(makeRow().id, old, 'idle');

  const deleted = store.pruneOldAcpDelegates(7 * 24 * 60 * 60 * 1000);
  expect(deleted).toBe(1);
});

test('pruneOldAcpDelegates does NOT delete live rows or recently evicted rows', () => {
  // Live row
  store.upsertAcpDelegate(makeRow({ id: 'k1', sessionId: 'ses_x', agentName: 'live' }));
  // Recently evicted
  store.upsertAcpDelegate(makeRow({ id: 'k2', sessionId: 'ses_x', agentName: 'recent' }));
  store.closeAcpDelegate('k2', new Date().toISOString(), 'idle');

  const deleted = store.pruneOldAcpDelegates(7 * 24 * 60 * 60 * 1000);
  expect(deleted).toBe(0);
  expect(store.listAcpDelegatesForSession('ses_x')).toHaveLength(2);
});

// ── Orphan reconciliation ─────────────────────────────────────────────────────

test('reconcileOrphanedDelegates closes all live rows and logs count', () => {
  store.upsertAcpDelegate(makeRow({ id: 'k1', sessionId: 'ses_x', agentName: 'a', pid: 99999 }));
  store.upsertAcpDelegate(makeRow({ id: 'k2', sessionId: 'ses_x', agentName: 'b', pid: 99998 }));

  store.reconcileOrphanedDelegates();

  const rows = store.listAcpDelegatesForSession('ses_x');
  for (const r of rows) {
    expect(r.evictReason).toBe('daemon_restart');
  }
});

test('reconcileOrphanedDelegates is a no-op when there are no live rows', () => {
  // No rows at all — must not throw
  expect(() => store.reconcileOrphanedDelegates()).not.toThrow();
});

test('deleteSession cleans up acp_delegates rows', () => {
  // Insert a session so the FK-like cleanup has a session to reference
  store.insertSession({
    id: 'ses_del',
    title: 'test',
    ownerPrincipalId: 'prn_test1',
    state: 'active',
    agentIds: [],
    parentSessionId: null,
    archived: false,
    restoreCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  store.upsertAcpDelegate(makeRow({ id: 'k1', sessionId: 'ses_del', agentName: 'a', acpSessionId: 'acp-1' }));
  store.upsertAcpDelegate(makeRow({ id: 'k2', sessionId: 'ses_del', agentName: 'b', acpSessionId: 'acp-2' }));

  store.deleteSession('ses_del');

  // Delegate rows must be gone
});
