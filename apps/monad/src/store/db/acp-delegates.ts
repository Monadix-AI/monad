// ACP delegate ledger: the live/evicted row lifecycle + startup orphan reconciliation. Split out of
// index.ts — every function takes the raw bun:sqlite handle.

import type { Database } from 'bun:sqlite';

/** A row from the acp_delegates table (camelCase). evictedAt=null means the delegate is live. */
export interface AcpDelegateRow {
  id: string;
  sessionId: string;
  agentName: string;
  acpSessionId: string;
  pid: number;
  spawnedAt: string;
  lastUsedAt: string;
  evictedAt: string | null;
  evictReason: string | null;
  reuseCount: number;
  promptCount: number;
}

function rowToAcpDelegate(r: Record<string, unknown>): AcpDelegateRow {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    agentName: r.agent_name as string,
    acpSessionId: r.acp_session_id as string,
    pid: r.pid as number,
    spawnedAt: r.spawned_at as string,
    lastUsedAt: r.last_used_at as string,
    evictedAt: (r.evicted_at as string | null) ?? null,
    evictReason: (r.evict_reason as string | null) ?? null,
    reuseCount: r.reuse_count as number,
    promptCount: r.prompt_count as number
  };
}

/** Insert a new live-delegate row on spawn. Upsert-safe: a re-spawn after eviction gets a fresh row. */
export function upsertAcpDelegate(
  sqlite: Database,
  row: Omit<AcpDelegateRow, 'evictedAt' | 'evictReason' | 'reuseCount' | 'promptCount'>
): void {
  sqlite
    .query(
      `INSERT INTO acp_delegates
         (id, session_id, agent_name, acp_session_id, pid, spawned_at, last_used_at,
          evicted_at, evict_reason, reuse_count, prompt_count)
       VALUES ($id, $sessionId, $agentName, $acpSessionId, $pid, $spawnedAt, $lastUsedAt,
               NULL, NULL, 0, 0)
       ON CONFLICT(id) DO UPDATE SET
         acp_session_id = excluded.acp_session_id,
         pid            = excluded.pid,
         spawned_at     = excluded.spawned_at,
         last_used_at   = excluded.last_used_at,
         evicted_at     = NULL,
         evict_reason   = NULL,
         reuse_count    = 0,
         prompt_count   = 0`
    )
    .run({
      $id: row.id,
      $sessionId: row.sessionId,
      $agentName: row.agentName,
      $acpSessionId: row.acpSessionId,
      $pid: row.pid,
      $spawnedAt: row.spawnedAt,
      $lastUsedAt: row.lastUsedAt
    });
}

/** Update stats after a successful prompt (called in promptDelegate's finally block).
 *  Returns true if a live row was updated, false if the row was already evicted or missing. */
export function touchAcpDelegate(
  sqlite: Database,
  id: string,
  lastUsedAt: string,
  reuseCount: number,
  promptCount: number
): boolean {
  const result = sqlite
    .query(
      'UPDATE acp_delegates SET last_used_at=$at, reuse_count=$rc, prompt_count=$pc WHERE id=$id AND evicted_at IS NULL'
    )
    .run({ $at: lastUsedAt, $rc: reuseCount, $pc: promptCount, $id: id });
  return result.changes > 0;
}

/** Mark a delegate as evicted (either by explicit eviction or daemon restart cleanup). */
export function closeAcpDelegate(sqlite: Database, id: string, evictedAt: string, reason: string): void {
  sqlite
    .query('UPDATE acp_delegates SET evicted_at=$at, evict_reason=$reason WHERE id=$id')
    .run({ $at: evictedAt, $reason: reason, $id: id });
}

/** All rows where evicted_at IS NULL — i.e. delegates that were live when the daemon last ran.
 *  Used at startup to detect and kill orphaned adapter processes. */
export function listLiveAcpDelegates(sqlite: Database): AcpDelegateRow[] {
  return (
    sqlite.query('SELECT * FROM acp_delegates WHERE evicted_at IS NULL ORDER BY spawned_at ASC').all() as Array<
      Record<string, unknown>
    >
  ).map(rowToAcpDelegate);
}

/** Recent delegate history for a session (live + evicted), newest first. */
export function listAcpDelegatesForSession(sqlite: Database, sessionId: string, limit = 50): AcpDelegateRow[] {
  return (
    sqlite
      .query('SELECT * FROM acp_delegates WHERE session_id=? ORDER BY spawned_at DESC LIMIT ?')
      .all(sessionId, limit) as Array<Record<string, unknown>>
  ).map(rowToAcpDelegate);
}

/** Delete rows evicted more than `olderThanMs` milliseconds ago. Returns deleted count. */
export function pruneOldAcpDelegates(sqlite: Database, olderThanMs = 7 * 24 * 60 * 60 * 1000): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  return sqlite.query('DELETE FROM acp_delegates WHERE evicted_at IS NOT NULL AND evicted_at < ?').run(cutoff).changes;
}

/**
 * On daemon startup: close every delegate row that was live when the daemon last stopped (evicted_at
 * NULL), attempt to kill their adapter processes (best-effort — the PIDs may already be dead), and
 * mark them evicted. Returns how many rows were closed.
 *
 * Call ONCE, early, before any new delegates are spawned.
 */
export function reconcileOrphanedDelegates(sqlite: Database): number {
  const orphans = listLiveAcpDelegates(sqlite);
  if (orphans.length === 0) return 0;
  const now = new Date().toISOString();
  for (const o of orphans) {
    if (o.pid > 0) {
      try {
        process.kill(o.pid, 'SIGTERM');
      } catch {
        // already dead — fine
      }
    }
    closeAcpDelegate(sqlite, o.id, now, 'daemon_restart');
  }
  return orphans.length;
}
