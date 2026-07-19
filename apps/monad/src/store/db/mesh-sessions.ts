// External agent session ledger: one row per CLI launch, provider mapping, delivery/visible cursors,
// and startup orphan reconciliation.

import type { Database } from 'bun:sqlite';
import type { MeshAgentProvider, MeshAgentRuntimeRole, MeshSessionState, SessionId } from '@monad/protocol';

// A native-CLI runtime is always launched under a specific session's own id (Track B P6b:
// every conversation — chat or project-bound — is a real Session; a project itself hosts no
// runtime directly). Kept as its own alias (not inlined to SessionId) since `transcriptTargetId`
// is this module's established field name.
export type MeshAgentTargetId = SessionId;

export interface MeshSessionRow {
  id: string;
  transcriptTargetId: MeshAgentTargetId;
  agentName: string;
  provider: MeshAgentProvider;
  workingPath: string;
  runtimeRole: MeshAgentRuntimeRole;
  agentRuntimeId: string | null;
  agentRuntimeTokenHash: string | null;
  lastDeliveredSeq: number;
  lastVisibleSeq: number;
  state: MeshSessionState;
  pid: number | null;
  providerSessionRef: string | null;
  outputSnapshot: string;
  exitCode: number | null;
  startedAt: string;
  updatedAt: string;
  exitedAt: string | null;
}

function rowToMeshSession(r: Record<string, unknown>): MeshSessionRow {
  return {
    id: r.id as string,
    transcriptTargetId: r.transcript_target_id as MeshAgentTargetId,
    agentName: r.agent_name as string,
    provider: r.provider as MeshAgentProvider,
    workingPath: r.working_path as string,
    runtimeRole: ((r.runtime_role as string | null) ?? 'interactive') as MeshAgentRuntimeRole,
    agentRuntimeId: (r.agent_runtime_id as string | null) ?? null,
    agentRuntimeTokenHash: (r.agent_runtime_token_hash as string | null) ?? null,
    lastDeliveredSeq: (r.last_delivered_seq as number | null) ?? 0,
    lastVisibleSeq: (r.last_visible_seq as number | null) ?? 0,
    state: r.state as MeshSessionState,
    pid: (r.pid as number | null) ?? null,
    providerSessionRef: (r.provider_session_ref as string | null) ?? null,
    outputSnapshot: '',
    exitCode: (r.exit_code as number | null) ?? null,
    startedAt: r.started_at as string,
    updatedAt: r.updated_at as string,
    exitedAt: (r.exited_at as string | null) ?? null
  };
}

export function upsertMeshSession(sqlite: Database, row: MeshSessionRow): void {
  sqlite
    .query(
      `INSERT INTO mesh_sessions
         (id, transcript_target_id, agent_name, provider, working_path, state,
          runtime_role, agent_runtime_id, agent_runtime_token_hash, last_delivered_seq, last_visible_seq, pid,
          provider_session_ref, exit_code, started_at, updated_at, exited_at)
       VALUES ($id, $transcriptTargetId, $agentName, $provider, $workingPath, $state,
               $runtimeRole, $agentRuntimeId, $agentRuntimeTokenHash, $lastDeliveredSeq, $lastVisibleSeq, $pid,
               $providerSessionRef, $exitCode, $startedAt, $updatedAt, $exitedAt)
       ON CONFLICT(id) DO UPDATE SET
         transcript_target_id = excluded.transcript_target_id,
         agent_name           = excluded.agent_name,
         provider             = excluded.provider,
         working_path         = excluded.working_path,
         runtime_role         = excluded.runtime_role,
         agent_runtime_id     = excluded.agent_runtime_id,
         agent_runtime_token_hash = excluded.agent_runtime_token_hash,
         last_delivered_seq   = excluded.last_delivered_seq,
         last_visible_seq     = excluded.last_visible_seq,
         state                = excluded.state,
         pid                  = excluded.pid,
         provider_session_ref = excluded.provider_session_ref,
         exit_code            = excluded.exit_code,
         updated_at           = excluded.updated_at,
         exited_at            = excluded.exited_at`
    )
    .run({
      $id: row.id,
      $transcriptTargetId: row.transcriptTargetId,
      $agentName: row.agentName,
      $provider: row.provider,
      $workingPath: row.workingPath,
      $runtimeRole: row.runtimeRole ?? 'interactive',
      $agentRuntimeId: row.agentRuntimeId ?? null,
      $agentRuntimeTokenHash: row.agentRuntimeTokenHash ?? null,
      $lastDeliveredSeq: row.lastDeliveredSeq ?? 0,
      $lastVisibleSeq: row.lastVisibleSeq ?? 0,
      $state: row.state,
      $pid: row.pid,
      $providerSessionRef: row.providerSessionRef,
      $exitCode: row.exitCode,
      $startedAt: row.startedAt,
      $updatedAt: row.updatedAt,
      $exitedAt: row.exitedAt
    });
}

export function getMeshSession(sqlite: Database, id: string): MeshSessionRow | null {
  const row = sqlite.query('SELECT * FROM mesh_sessions WHERE id = ?').get(id) as Record<string, unknown> | null;
  return row ? rowToMeshSession(row) : null;
}

export function listMeshSessionsForTranscriptTarget(sqlite: Database, transcriptTargetId: string): MeshSessionRow[] {
  return (
    sqlite
      .query('SELECT * FROM mesh_sessions WHERE transcript_target_id = ? ORDER BY started_at DESC')
      .all(transcriptTargetId) as Array<Record<string, unknown>>
  ).map(rowToMeshSession);
}

export function listMeshSessions(sqlite: Database): MeshSessionRow[] {
  return (
    sqlite.query('SELECT * FROM mesh_sessions ORDER BY started_at DESC').all() as Array<Record<string, unknown>>
  ).map(rowToMeshSession);
}

export function listLiveMeshSessions(sqlite: Database): MeshSessionRow[] {
  return (
    sqlite
      .query("SELECT * FROM mesh_sessions WHERE state IN ('starting', 'running') ORDER BY started_at ASC")
      .all() as Array<Record<string, unknown>>
  ).map(rowToMeshSession);
}

/** Delete terminal (exited/failed/stopped) sessions older than `olderThanMs`. */
export function pruneExitedMeshSessions(sqlite: Database, olderThanMs = 7 * 24 * 60 * 60 * 1000): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  return sqlite
    .query(
      "DELETE FROM mesh_sessions WHERE state IN ('exited','failed','stopped') AND exited_at IS NOT NULL AND exited_at < ?"
    )
    .run(cutoff).changes;
}

export function updateMeshSessionRef(sqlite: Database, id: string, providerSessionRef: string): boolean {
  const result = sqlite
    .query('UPDATE mesh_sessions SET provider_session_ref = ?, updated_at = ? WHERE id = ?')
    .run(providerSessionRef, new Date().toISOString(), id);
  return result.changes > 0;
}

export function clearMeshSessionRef(sqlite: Database, id: string): boolean {
  const result = sqlite
    .query('UPDATE mesh_sessions SET provider_session_ref = NULL, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
  return result.changes > 0;
}

export function setMeshAgentVisibleCursor(sqlite: Database, id: string, seq: number): boolean {
  const result = sqlite
    .query(
      `UPDATE mesh_sessions
       SET last_visible_seq = MAX(last_visible_seq, ?), updated_at = ?
       WHERE id = ?`
    )
    .run(seq, new Date().toISOString(), id);
  return result.changes > 0;
}

export function setMeshAgentDeliveredCursor(sqlite: Database, id: string, seq: number): boolean {
  const result = sqlite
    .query(
      `UPDATE mesh_sessions
       SET last_delivered_seq = MAX(last_delivered_seq, ?), updated_at = ?
       WHERE id = ?`
    )
    .run(seq, new Date().toISOString(), id);
  return result.changes > 0;
}

export function closeMeshSession(
  sqlite: Database,
  id: string,
  exitedAt: string,
  exitCode: number | null,
  state: 'exited' | 'failed' | 'stopped' = 'exited'
): boolean {
  const result = sqlite
    .query(
      `UPDATE mesh_sessions
       SET state = ?, exit_code = ?, exited_at = ?, updated_at = ?
       WHERE id = ?
         AND state IN ('starting', 'running')`
    )
    .run(state, exitCode, exitedAt, exitedAt, id);
  return result.changes > 0;
}

export function reconcileOrphanedMeshSessions(
  sqlite: Database,
  killPid: (pid: number) => void = (pid) => process.kill(pid, 'SIGTERM')
): number {
  const orphans = listLiveMeshSessions(sqlite);
  if (orphans.length === 0) return 0;
  const now = new Date().toISOString();
  for (const orphan of orphans) {
    if (orphan.pid !== null && orphan.pid > 0) {
      try {
        killPid(orphan.pid);
      } catch {
        // already dead
      }
    }
    closeMeshSession(sqlite, orphan.id, now, null, 'stopped');
  }
  return orphans.length;
}
