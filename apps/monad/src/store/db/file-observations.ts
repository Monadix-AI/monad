import type { Database } from 'bun:sqlite';

export interface FileObservationRow {
  path: string;
  hash: string;
  coverage: 'full';
  observedAt: string;
  toolCallId?: string;
}

export function recordFileObservation(sqlite: Database, sessionId: string, observation: FileObservationRow): void {
  sqlite
    .query(
      `INSERT INTO file_observations (session_id, path, hash, coverage, observed_at, tool_call_id)
       VALUES ($sessionId, $path, $hash, $coverage, $observedAt, $toolCallId)
       ON CONFLICT(session_id, path) DO UPDATE SET
         hash = excluded.hash,
         coverage = excluded.coverage,
         observed_at = excluded.observed_at,
         tool_call_id = excluded.tool_call_id`
    )
    .run({
      $sessionId: sessionId,
      $path: observation.path,
      $hash: observation.hash,
      $coverage: observation.coverage,
      $observedAt: observation.observedAt,
      $toolCallId: observation.toolCallId ?? null
    });
}

export function getFileObservation(sqlite: Database, sessionId: string, path: string): FileObservationRow | null {
  const row = sqlite
    .query(
      `SELECT path, hash, coverage, observed_at, tool_call_id
       FROM file_observations
       WHERE session_id = ? AND path = ?`
    )
    .get(sessionId, path) as {
    path: string;
    hash: string;
    coverage: string;
    observed_at: string;
    tool_call_id: string | null;
  } | null;
  if (row?.coverage !== 'full') return null;
  return {
    path: row.path,
    hash: row.hash,
    coverage: row.coverage,
    observedAt: row.observed_at,
    ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {})
  };
}

export function clearFileObservations(sqlite: Database, sessionId: string): number {
  return sqlite.query('DELETE FROM file_observations WHERE session_id = ?').run(sessionId).changes;
}

export function clearFileObservationsIfObservedSince(sqlite: Database, sessionId: string, since: string): number {
  const row = sqlite
    .query(
      `SELECT 1 AS found
       FROM file_observations
       WHERE session_id = ? AND observed_at >= ?
       LIMIT 1`
    )
    .get(sessionId, since) as { found: number } | null;
  return row ? clearFileObservations(sqlite, sessionId) : 0;
}
