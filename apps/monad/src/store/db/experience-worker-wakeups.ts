import type { Database } from 'bun:sqlite';

export interface ExperienceWorkerWakeupRecord {
  atomPackId: string;
  principalId: string;
  projectId: string;
  key: string;
  runAt: string;
  attempt: number;
}

type WakeupRow = {
  atom_pack_id: string;
  principal_id: string;
  project_id: string;
  wake_key: string;
  run_at: string;
  attempt: number;
};

export function scheduleExperienceWorkerWakeup(
  db: Database,
  input: Omit<ExperienceWorkerWakeupRecord, 'attempt'>
): void {
  db.query(
    `INSERT INTO experience_worker_wakeups
       (atom_pack_id, principal_id, project_id, wake_key, run_at, attempt, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(atom_pack_id, principal_id, project_id, wake_key) DO UPDATE SET
       run_at = excluded.run_at, attempt = 0, updated_at = excluded.updated_at`
  ).run(input.atomPackId, input.principalId, input.projectId, input.key, input.runAt, new Date().toISOString());
}

export function cancelExperienceWorkerWakeup(
  db: Database,
  atomPackId: string,
  principalId: string,
  projectId: string,
  key: string
): void {
  db.query(
    `DELETE FROM experience_worker_wakeups
     WHERE atom_pack_id = ? AND principal_id = ? AND project_id = ? AND wake_key = ?`
  ).run(atomPackId, principalId, projectId, key);
}

export function listDueExperienceWorkerWakeups(db: Database, now: string): ExperienceWorkerWakeupRecord[] {
  return db
    .query<WakeupRow, [string]>(
      `SELECT atom_pack_id, principal_id, project_id, wake_key, run_at, attempt
       FROM experience_worker_wakeups WHERE run_at <= ?
       ORDER BY run_at, atom_pack_id, project_id, wake_key`
    )
    .all(now)
    .map((row) => ({
      atomPackId: row.atom_pack_id,
      principalId: row.principal_id,
      projectId: row.project_id,
      key: row.wake_key,
      runAt: row.run_at,
      attempt: row.attempt
    }));
}
