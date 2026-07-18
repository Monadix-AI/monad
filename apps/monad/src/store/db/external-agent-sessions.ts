// External agent session ledger: one row per CLI launch, provider mapping, delivery/visible cursors,
// and startup orphan reconciliation.

import type { Database } from 'bun:sqlite';
import type {
  ExternalAgentLaunchMode,
  ExternalAgentProvider,
  ExternalAgentRuntimeRole,
  ExternalAgentSessionState,
  SessionId
} from '@monad/protocol';

// A native-CLI runtime is always launched under a specific session's own id (Track B P6b:
// every conversation — chat or project-bound — is a real Session; a project itself hosts no
// runtime directly). Kept as its own alias (not inlined to SessionId) since `transcriptTargetId`
// is this module's established field name.
export type ExternalAgentTargetId = SessionId;

export interface ExternalAgentSessionRow {
  id: string;
  transcriptTargetId: ExternalAgentTargetId;
  agentName: string;
  provider: ExternalAgentProvider;
  workingPath: string;
  launchMode: ExternalAgentLaunchMode;
  runtimeRole: ExternalAgentRuntimeRole;
  agentRuntimeId: string | null;
  agentRuntimeTokenHash: string | null;
  lastDeliveredSeq: number;
  lastVisibleSeq: number;
  state: ExternalAgentSessionState;
  pid: number | null;
  providerSessionRef: string | null;
  outputSnapshot: string;
  exitCode: number | null;
  startedAt: string;
  updatedAt: string;
  exitedAt: string | null;
}

function rowToExternalAgentSession(r: Record<string, unknown>): ExternalAgentSessionRow {
  return {
    id: r.id as string,
    transcriptTargetId: r.transcript_target_id as ExternalAgentTargetId,
    agentName: r.agent_name as string,
    provider: r.provider as ExternalAgentProvider,
    workingPath: r.working_path as string,
    launchMode: r.launch_mode as ExternalAgentLaunchMode,
    runtimeRole: ((r.runtime_role as string | null) ?? 'interactive') as ExternalAgentRuntimeRole,
    agentRuntimeId: (r.agent_runtime_id as string | null) ?? null,
    agentRuntimeTokenHash: (r.agent_runtime_token_hash as string | null) ?? null,
    lastDeliveredSeq: (r.last_delivered_seq as number | null) ?? 0,
    lastVisibleSeq: (r.last_visible_seq as number | null) ?? 0,
    state: r.state as ExternalAgentSessionState,
    pid: (r.pid as number | null) ?? null,
    providerSessionRef: (r.provider_session_ref as string | null) ?? null,
    outputSnapshot: '',
    exitCode: (r.exit_code as number | null) ?? null,
    startedAt: r.started_at as string,
    updatedAt: r.updated_at as string,
    exitedAt: (r.exited_at as string | null) ?? null
  };
}

export function upsertExternalAgentSession(sqlite: Database, row: ExternalAgentSessionRow): void {
  sqlite
    .query(
      `INSERT INTO external_agent_sessions
         (id, transcript_target_id, agent_name, provider, working_path, launch_mode, state,
          runtime_role, agent_runtime_id, agent_runtime_token_hash, last_delivered_seq, last_visible_seq, pid,
          provider_session_ref, exit_code, started_at, updated_at, exited_at)
       VALUES ($id, $transcriptTargetId, $agentName, $provider, $workingPath, $launchMode, $state,
               $runtimeRole, $agentRuntimeId, $agentRuntimeTokenHash, $lastDeliveredSeq, $lastVisibleSeq, $pid,
               $providerSessionRef, $exitCode, $startedAt, $updatedAt, $exitedAt)
       ON CONFLICT(id) DO UPDATE SET
         transcript_target_id = excluded.transcript_target_id,
         agent_name           = excluded.agent_name,
         provider             = excluded.provider,
         working_path         = excluded.working_path,
         launch_mode          = excluded.launch_mode,
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
      $launchMode: row.launchMode,
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

export function getExternalAgentSession(sqlite: Database, id: string): ExternalAgentSessionRow | null {
  const row = sqlite.query('SELECT * FROM external_agent_sessions WHERE id = ?').get(id) as Record<
    string,
    unknown
  > | null;
  return row ? rowToExternalAgentSession(row) : null;
}

export function listExternalAgentSessionsForTranscriptTarget(
  sqlite: Database,
  transcriptTargetId: string
): ExternalAgentSessionRow[] {
  return (
    sqlite
      .query('SELECT * FROM external_agent_sessions WHERE transcript_target_id = ? ORDER BY started_at DESC')
      .all(transcriptTargetId) as Array<Record<string, unknown>>
  ).map(rowToExternalAgentSession);
}

export function listExternalAgentSessions(sqlite: Database): ExternalAgentSessionRow[] {
  return (
    sqlite.query('SELECT * FROM external_agent_sessions ORDER BY started_at DESC').all() as Array<
      Record<string, unknown>
    >
  ).map(rowToExternalAgentSession);
}

export function listLiveExternalAgentSessions(sqlite: Database): ExternalAgentSessionRow[] {
  return (
    sqlite
      .query("SELECT * FROM external_agent_sessions WHERE state IN ('starting', 'running') ORDER BY started_at ASC")
      .all() as Array<Record<string, unknown>>
  ).map(rowToExternalAgentSession);
}

/** Delete terminal (exited/failed/stopped) sessions older than `olderThanMs`. */
export function pruneExitedExternalAgentSessions(sqlite: Database, olderThanMs = 7 * 24 * 60 * 60 * 1000): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  return sqlite
    .query(
      "DELETE FROM external_agent_sessions WHERE state IN ('exited','failed','stopped') AND exited_at IS NOT NULL AND exited_at < ?"
    )
    .run(cutoff).changes;
}

export function updateExternalAgentSessionRef(sqlite: Database, id: string, providerSessionRef: string): boolean {
  const result = sqlite
    .query('UPDATE external_agent_sessions SET provider_session_ref = ?, updated_at = ? WHERE id = ?')
    .run(providerSessionRef, new Date().toISOString(), id);
  return result.changes > 0;
}

export function clearExternalAgentSessionRef(sqlite: Database, id: string): boolean {
  const result = sqlite
    .query('UPDATE external_agent_sessions SET provider_session_ref = NULL, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
  return result.changes > 0;
}

export function setExternalAgentVisibleCursor(sqlite: Database, id: string, seq: number): boolean {
  const result = sqlite
    .query(
      `UPDATE external_agent_sessions
       SET last_visible_seq = MAX(last_visible_seq, ?), updated_at = ?
       WHERE id = ?`
    )
    .run(seq, new Date().toISOString(), id);
  return result.changes > 0;
}

export function setExternalAgentDeliveredCursor(sqlite: Database, id: string, seq: number): boolean {
  const result = sqlite
    .query(
      `UPDATE external_agent_sessions
       SET last_delivered_seq = MAX(last_delivered_seq, ?), updated_at = ?
       WHERE id = ?`
    )
    .run(seq, new Date().toISOString(), id);
  return result.changes > 0;
}

export function closeExternalAgentSession(
  sqlite: Database,
  id: string,
  exitedAt: string,
  exitCode: number | null,
  state: 'exited' | 'failed' | 'stopped' = 'exited'
): boolean {
  const result = sqlite
    .query(
      `UPDATE external_agent_sessions
       SET state = ?, exit_code = ?, exited_at = ?, updated_at = ?
       WHERE id = ?
         AND state IN ('starting', 'running')`
    )
    .run(state, exitCode, exitedAt, exitedAt, id);
  return result.changes > 0;
}

export function reconcileOrphanedExternalAgentSessions(
  sqlite: Database,
  killPid: (pid: number) => void = (pid) => process.kill(pid, 'SIGTERM')
): number {
  const orphans = listLiveExternalAgentSessions(sqlite);
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
    closeExternalAgentSession(sqlite, orphan.id, now, null, 'stopped');
  }
  return orphans.length;
}
