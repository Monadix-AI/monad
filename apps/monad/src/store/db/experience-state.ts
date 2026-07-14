import type { Database } from 'bun:sqlite';

export interface ExperienceStateRecord {
  key: string;
  value: unknown;
  version: number;
}

export interface ExperienceStateEventRecord {
  id: string;
  version: number;
  payload: unknown;
  createdAt: string;
}

type StateRow = { record_key: string; value: string; version: number };
type EventRow = { id: string; version: number; payload: string; created_at: string };

export function getExperienceState(
  db: Database,
  atomPackId: string,
  principalId: string,
  projectId: string,
  key: string
): ExperienceStateRecord | null {
  const row = db
    .query<StateRow, [string, string, string, string]>(
      `SELECT record_key, value, version FROM experience_state
       WHERE atom_pack_id = ? AND principal_id = ? AND project_id = ? AND record_key = ?`
    )
    .get(atomPackId, principalId, projectId, key);
  return row ? { key: row.record_key, value: JSON.parse(row.value), version: row.version } : null;
}

export function listExperienceState(
  db: Database,
  atomPackId: string,
  principalId: string,
  projectId: string,
  prefix: string
): ExperienceStateRecord[] {
  return db
    .query<StateRow, [string, string, string, string, string]>(
      `SELECT record_key, value, version FROM experience_state
       WHERE atom_pack_id = ? AND principal_id = ? AND project_id = ?
         AND record_key >= ? AND record_key < ?
       ORDER BY record_key`
    )
    .all(atomPackId, principalId, projectId, prefix, `${prefix}\uffff`)
    .map((row) => ({ key: row.record_key, value: JSON.parse(row.value), version: row.version }));
}

export function compareAndSwapExperienceState(
  db: Database,
  input: {
    atomPackId: string;
    principalId: string;
    projectId: string;
    key: string;
    expectedVersion: number | null;
    value: unknown;
    event: unknown;
  }
): boolean {
  return db.transaction(() => {
    const current = getExperienceState(db, input.atomPackId, input.principalId, input.projectId, input.key);
    if (input.expectedVersion === null ? current !== null : current?.version !== input.expectedVersion) return false;
    const version = input.expectedVersion === null ? 0 : input.expectedVersion + 1;
    const now = new Date().toISOString();
    db.query(
      `INSERT INTO experience_state
         (atom_pack_id, principal_id, project_id, record_key, value, version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(atom_pack_id, principal_id, project_id, record_key) DO UPDATE SET
         value = excluded.value, version = excluded.version, updated_at = excluded.updated_at`
    ).run(input.atomPackId, input.principalId, input.projectId, input.key, JSON.stringify(input.value), version, now);
    db.query(
      `INSERT INTO experience_state_events
         (id, atom_pack_id, principal_id, project_id, record_key, version, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      crypto.randomUUID(),
      input.atomPackId,
      input.principalId,
      input.projectId,
      input.key,
      version,
      JSON.stringify(input.event),
      now
    );
    return true;
  })();
}

export function listExperienceStateEvents(
  db: Database,
  atomPackId: string,
  principalId: string,
  projectId: string,
  key: string
): ExperienceStateEventRecord[] {
  return db
    .query<EventRow, [string, string, string, string]>(
      `SELECT id, version, payload, created_at FROM experience_state_events
       WHERE atom_pack_id = ? AND principal_id = ? AND project_id = ? AND record_key = ?
       ORDER BY rowid`
    )
    .all(atomPackId, principalId, projectId, key)
    .map((row) => ({ id: row.id, version: row.version, payload: JSON.parse(row.payload), createdAt: row.created_at }));
}
