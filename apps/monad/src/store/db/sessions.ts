// Session + workplace-project CRUD and per-session usage accumulation. Split out of index.ts.

import type { Database } from 'bun:sqlite';
import type { Session, SessionState, TokenUsage, WorkplaceProject } from '@monad/protocol';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { and, count, desc, eq, or, sql } from 'drizzle-orm';

import { rowToSession, rowToWorkplaceProject } from './row-mappers.ts';
import { sessions, workplaceProjects } from './schema.ts';
import { parseSessionModelSelection, serializeSessionModelSelection } from './session-model-selection.ts';

type Db = BunSQLiteDatabase<Record<string, never>>;

export interface ListSessionsFilter {
  archived?: boolean;
  state?: SessionState;
  /** Scope to sessions under one Workplace Project (Track B); omitted → plain chat sessions are not
   *  filtered out, so callers that only want chat sessions must also exclude rows with a projectId. */
  projectId?: string;
  query?: string;
  limit?: number;
  offset?: number;
}

export interface SessionPatch {
  title?: string;
  state?: SessionState;
  archived?: boolean;
  agentIds?: Session['agentIds'];
  model?: string | null;
  reasoningEffort?: string | null;
  cwd?: string | null;
  origin?: Session['origin'] | null;
}

export interface WorkplaceProjectPatch {
  title?: string;
  state?: SessionState;
  archived?: boolean;
  model?: string | null;
  cwd?: string | null;
  origin?: WorkplaceProject['origin'] | null;
  memberTemplates?: WorkplaceProject['memberTemplates'];
}

export function insertSession(db: Db, s: Session): void {
  db.insert(sessions)
    .values({
      id: s.id,
      projectId: s.projectId ?? null,
      title: s.title,
      state: s.state,
      agentIds: JSON.stringify(s.agentIds),
      archived: s.archived ? 1 : 0,
      restoreCount: s.restoreCount,
      model: serializeSessionModelSelection({ model: s.model, effort: s.reasoningEffort }),
      cwd: s.cwd ?? null,
      origin: s.origin ? JSON.stringify(s.origin) : null,
      inputTokens: s.usage?.inputTokens ?? 0,
      outputTokens: s.usage?.outputTokens ?? 0,
      totalTokens: s.usage?.totalTokens ?? 0,
      cacheReadTokens: s.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: s.usage?.cacheWriteTokens ?? 0,
      reasoningTokens: s.usage?.reasoningTokens ?? 0,
      costUsd: s.costUsd ?? 0,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt
    })
    .run();
}

export function listSessions(db: Db, filter: ListSessionsFilter = {}): Session[] {
  const conds = sessionFilterConditions(filter);
  const where = conds.length === 1 ? conds[0] : conds.length > 1 ? and(...conds) : undefined;
  const base = db.select().from(sessions).where(where).orderBy(desc(sessions.updatedAt), desc(sessions.id));
  const limited = filter.limit !== undefined ? base.limit(filter.limit) : base;
  const paged = filter.offset !== undefined ? limited.offset(filter.offset) : limited;
  return paged.all().map(rowToSession);
}

export function countSessions(db: Db, filter: Omit<ListSessionsFilter, 'limit' | 'offset'> = {}): number {
  const conds = sessionFilterConditions(filter);
  const where = conds.length === 1 ? conds[0] : conds.length > 1 ? and(...conds) : undefined;
  const result = db.select({ count: count() }).from(sessions).where(where).get();
  return result?.count ?? 0;
}

function sessionFilterConditions(filter: Omit<ListSessionsFilter, 'limit' | 'offset'>) {
  const conds = [];
  if (filter.archived !== undefined) conds.push(eq(sessions.archived, filter.archived ? 1 : 0));
  if (filter.state !== undefined) conds.push(eq(sessions.state, filter.state));
  if (filter.projectId !== undefined) conds.push(eq(sessions.projectId, filter.projectId));
  const query = filter.query?.trim();
  if (query) {
    const pattern = `%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    conds.push(
      or(
        sql`lower(${sessions.title}) LIKE lower(${pattern}) ESCAPE '\\'`,
        sql`lower(${sessions.id}) LIKE lower(${pattern}) ESCAPE '\\'`,
        sql`EXISTS (
          SELECT 1 FROM ${workplaceProjects}
          WHERE ${workplaceProjects.id} = ${sessions.projectId}
            AND lower(${workplaceProjects.title}) LIKE lower(${pattern}) ESCAPE '\\'
        )`
      )
    );
  }
  return conds;
}

export function getSession(db: Db, id: string): Session | null {
  const row = db.select().from(sessions).where(eq(sessions.id, id)).get();
  return row ? rowToSession(row) : null;
}

/** Bumps updatedAt. Returns the updated row, or null if not found. */
export function updateSession(db: Db, id: string, patch: SessionPatch): Session | null {
  const sets: Partial<typeof sessions.$inferInsert> = { updatedAt: new Date().toISOString() };
  if (patch.title !== undefined) sets.title = patch.title;
  if (patch.state !== undefined) sets.state = patch.state;
  if (patch.archived !== undefined) sets.archived = patch.archived ? 1 : 0;
  if (patch.agentIds !== undefined) sets.agentIds = JSON.stringify(patch.agentIds);
  if (patch.model !== undefined || patch.reasoningEffort !== undefined) {
    const current = parseSessionModelSelection(
      db.select({ model: sessions.model }).from(sessions).where(eq(sessions.id, id)).get()?.model ?? null
    );
    sets.model = serializeSessionModelSelection({
      model: patch.model === undefined ? current.model : (patch.model ?? undefined),
      effort: patch.reasoningEffort === undefined ? current.effort : (patch.reasoningEffort ?? undefined)
    });
  }
  if (patch.cwd !== undefined) sets.cwd = patch.cwd;
  if (patch.origin !== undefined) sets.origin = patch.origin ? JSON.stringify(patch.origin) : null;
  db.update(sessions).set(sets).where(eq(sessions.id, id)).run();
  return getSession(db, id);
}

/** Delete every row owned by a session, across every table that scopes data by session id —
 *  the single cascade both `deleteSession` and `deleteWorkplaceProject` (per contained session)
 *  drive from, so the two paths can't drift out of sync again. Does not delete the `sessions`
 *  row itself. */
function deleteSessionOwnedData(sqlite: Database, sid: string): void {
  sqlite
    .query(
      'DELETE FROM message_embeddings WHERE message_id IN (SELECT id FROM messages WHERE transcript_target_id = ?)'
    )
    .run(sid);
  sqlite.query('DELETE FROM tasks WHERE session_id = ?').run(sid);
  sqlite.query('DELETE FROM memory WHERE session_id = ?').run(sid);
  sqlite.query('DELETE FROM file_observations WHERE session_id = ?').run(sid);
  sqlite.query('DELETE FROM messages WHERE transcript_target_id = ?').run(sid);
  sqlite.query('DELETE FROM events WHERE transcript_target_id = ?').run(sid);
  sqlite.query('DELETE FROM tool_raw_outputs WHERE transcript_target_id = ?').run(sid);
  sqlite.query('DELETE FROM acp_delegates WHERE session_id = ?').run(sid);
  sqlite.query('DELETE FROM channel_conversation_sessions WHERE session_id = ?').run(sid);
  sqlite.query('DELETE FROM channel_conversations WHERE active_session_id = ?').run(sid);
  sqlite.query('DELETE FROM native_agent_direct_messages WHERE session_id = ?').run(sid);
  sqlite.query('DELETE FROM message_attachments WHERE session_id = ?').run(sid);
  sqlite
    .query(
      `DELETE FROM mesh_agent_inbox_items
       WHERE mesh_session_id IN (SELECT id FROM mesh_sessions WHERE transcript_target_id = ?)`
    )
    .run(sid);
  sqlite.query('DELETE FROM mesh_sessions WHERE transcript_target_id = ?').run(sid);
}

export function deleteSession(sqlite: Database, id: string): boolean {
  const tx = sqlite.transaction((sid: string) => {
    deleteSessionOwnedData(sqlite, sid);
    return sqlite.query('DELETE FROM sessions WHERE id = ?').run(sid).changes;
  });
  return tx(id) > 0;
}

export function insertWorkplaceProject(db: Db, project: WorkplaceProject): void {
  db.insert(workplaceProjects)
    .values({
      id: project.id,
      title: project.title,
      state: project.state,
      archived: project.archived ? 1 : 0,
      model: project.model ?? null,
      cwd: project.cwd ?? null,
      origin: project.origin ? JSON.stringify(project.origin) : null,
      memberTemplates: JSON.stringify(project.memberTemplates),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt
    })
    .run();
}

export function listWorkplaceProjects(db: Db, filter: ListSessionsFilter = {}): WorkplaceProject[] {
  const conds = [];
  if (filter.archived !== undefined) conds.push(eq(workplaceProjects.archived, filter.archived ? 1 : 0));
  if (filter.state !== undefined) conds.push(eq(workplaceProjects.state, filter.state));
  const where = conds.length === 1 ? conds[0] : conds.length > 1 ? and(...conds) : undefined;
  const base = db
    .select()
    .from(workplaceProjects)
    .where(where)
    .orderBy(desc(workplaceProjects.updatedAt), desc(workplaceProjects.id));
  const limited = filter.limit !== undefined ? base.limit(filter.limit) : base;
  const paged = filter.offset !== undefined ? limited.offset(filter.offset) : limited;
  return paged.all().map(rowToWorkplaceProject);
}

export function countWorkplaceProjects(db: Db, filter: Omit<ListSessionsFilter, 'limit' | 'offset'> = {}): number {
  const conds = [];
  if (filter.archived !== undefined) conds.push(eq(workplaceProjects.archived, filter.archived ? 1 : 0));
  if (filter.state !== undefined) conds.push(eq(workplaceProjects.state, filter.state));
  const where = conds.length === 1 ? conds[0] : conds.length > 1 ? and(...conds) : undefined;
  return db.select({ count: count() }).from(workplaceProjects).where(where).get()?.count ?? 0;
}

export function getWorkplaceProject(db: Db, id: string): WorkplaceProject | null {
  const row = db.select().from(workplaceProjects).where(eq(workplaceProjects.id, id)).get();
  return row ? rowToWorkplaceProject(row) : null;
}

export function updateWorkplaceProject(db: Db, id: string, patch: WorkplaceProjectPatch): WorkplaceProject | null {
  const sets: Partial<typeof workplaceProjects.$inferInsert> = { updatedAt: new Date().toISOString() };
  if (patch.title !== undefined) sets.title = patch.title;
  if (patch.state !== undefined) sets.state = patch.state;
  if (patch.archived !== undefined) sets.archived = patch.archived ? 1 : 0;
  if (patch.model !== undefined) sets.model = patch.model;
  if (patch.cwd !== undefined) sets.cwd = patch.cwd;
  if (patch.origin !== undefined) sets.origin = patch.origin ? JSON.stringify(patch.origin) : null;
  if (patch.memberTemplates !== undefined) sets.memberTemplates = JSON.stringify(patch.memberTemplates);
  db.update(workplaceProjects).set(sets).where(eq(workplaceProjects.id, id)).run();
  return getWorkplaceProject(db, id);
}

export function deleteWorkplaceProject(sqlite: Database, id: string): boolean {
  const tx = sqlite.transaction((projectId: string) => {
    // Sessions are owned by the project (`sessions.project_id`), not scoped to it by a shared
    // transcript id — this function used to delete `WHERE transcript_target_id = projectId` /
    // `WHERE project_id = projectId` against tables keyed by *session* id, which never matched a
    // `prj_*` value and left every contained session's messages, events, DMs, and attachments
    // behind. Delete each owned session (and everything it owns) explicitly instead.
    const sessionIds = (
      sqlite.query('SELECT id FROM sessions WHERE project_id = ?').all(projectId) as Array<{
        id: string;
      }>
    ).map((row) => row.id);
    for (const sid of sessionIds) deleteSessionOwnedData(sqlite, sid);
    if (sessionIds.length > 0) {
      sqlite.query(`DELETE FROM sessions WHERE id IN (${sessionIds.map(() => '?').join(',')})`).run(...sessionIds);
    }
    sqlite.query('DELETE FROM experience_state WHERE project_id = ?').run(projectId);
    sqlite.query('DELETE FROM experience_state_events WHERE project_id = ?').run(projectId);
    sqlite.query('DELETE FROM experience_worker_wakeups WHERE project_id = ?').run(projectId);
    return sqlite.query('DELETE FROM workplace_projects WHERE id = ?').run(projectId).changes;
  });
  return tx(id) > 0;
}

export function clearMessages(sqlite: Database, db: Db, id: string): number {
  const tx = sqlite.transaction((sid: string) => {
    // Count BEFORE deleting: the messages table has AFTER-DELETE FTS triggers, and bun:sqlite's
    // `result.changes` includes trigger-affected rows — so a DELETE's `.changes` over-counts. A
    // direct COUNT(*) is the only reliable "how many messages did we clear" (drives /reset's reply).
    const row = sqlite.query('SELECT COUNT(*) AS n FROM messages WHERE transcript_target_id = ?').get(sid) as {
      n: number;
    };
    sqlite
      .query(
        'DELETE FROM message_embeddings WHERE message_id IN (SELECT id FROM messages WHERE transcript_target_id = ?)'
      )
      .run(sid);
    sqlite.query('DELETE FROM messages WHERE transcript_target_id = ?').run(sid);
    sqlite.query('DELETE FROM events WHERE transcript_target_id = ?').run(sid);
    sqlite.query("DELETE FROM memory WHERE session_id = ? AND key = 'ctx:summary'").run(sid);
    sqlite.query('DELETE FROM tool_raw_outputs WHERE transcript_target_id = ?').run(sid);
    sqlite.query('DELETE FROM file_observations WHERE session_id = ?').run(sid);
    const updatedAt = new Date().toISOString();
    db.update(sessions).set({ updatedAt }).where(eq(sessions.id, sid)).run();
    db.update(workplaceProjects).set({ updatedAt }).where(eq(workplaceProjects.id, sid)).run();
    return row.n;
  });
  return tx(id);
}

/** Accumulate one turn's REAL usage + cost into a session (per-session, resettable). Missing
 *  fields contribute 0 (presence ≠ value — never invent). */
export function addUsage(sqlite: Database, id: string, usage: TokenUsage, costUsd = 0): void {
  sqlite
    .query(
      `UPDATE sessions SET
         input_tokens       = input_tokens       + $in,
         output_tokens      = output_tokens      + $out,
         total_tokens       = total_tokens       + $total,
         cache_read_tokens  = cache_read_tokens  + $cr,
         cache_write_tokens = cache_write_tokens + $cw,
         reasoning_tokens   = reasoning_tokens   + $rt,
         cost_usd           = cost_usd           + $cost,
         updated_at         = $at
       WHERE id = $id`
    )
    .run({
      $in: usage.inputTokens ?? 0,
      $out: usage.outputTokens ?? 0,
      $total: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      $cr: usage.cacheReadTokens ?? 0,
      $cw: usage.cacheWriteTokens ?? 0,
      $rt: usage.reasoningTokens ?? 0,
      $cost: costUsd,
      $at: new Date().toISOString(),
      $id: id
    });
}
