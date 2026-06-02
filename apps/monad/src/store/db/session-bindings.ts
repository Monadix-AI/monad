import type { Database } from 'bun:sqlite';
import type { MeshSessionId, MeshSessionState, SessionBinding, SessionBindingLifecycle } from '@monad/protocol';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { sessionBindingSchema } from '@monad/protocol';
import { and, asc, eq, sql } from 'drizzle-orm';

import { sessionBindings, sessions } from './schema.ts';

type Db = BunSQLiteDatabase<Record<string, never>>;
type SessionBindingRow = typeof sessionBindings.$inferSelect;
// Only a terminal state may settle a binding's current runtime — never 'starting'/'running', which would
// clear current for a runtime that is still live. Derived from MeshSessionState so the two can't drift.
export type MeshSessionTerminalState = Extract<MeshSessionState, 'exited' | 'failed' | 'stopped'>;
export type SessionBindingInsert = Omit<SessionBinding, 'currentNativeRuntimeSessionId' | 'lastHealth'>;

export interface SessionBindingPatch {
  lifecycle?: SessionBindingLifecycle;
  lastHealth?: MeshSessionState | null;
  updatedAt: string;
}

function rowToSessionBinding(row: SessionBindingRow): SessionBinding {
  return sessionBindingSchema.parse({
    sessionId: row.sessionId,
    projectMemberId: row.projectMemberId,
    lastDeliveredSeq: row.lastDeliveredSeq,
    lastVisibleSeq: row.lastVisibleSeq,
    currentNativeRuntimeSessionId: row.currentNativeRuntimeSessionId,
    lifecycle: row.lifecycle,
    lastHealth: row.lastHealth,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  });
}

export function insertSessionBinding(sqlite: Database, db: Db, input: SessionBindingInsert): void {
  const binding = sessionBindingSchema.parse({
    sessionId: input.sessionId,
    projectMemberId: input.projectMemberId,
    lastDeliveredSeq: input.lastDeliveredSeq,
    lastVisibleSeq: input.lastVisibleSeq,
    currentNativeRuntimeSessionId: null,
    lifecycle: input.lifecycle,
    lastHealth: null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt
  });
  sqlite.transaction(() => {
    const owner = sqlite
      .query(
        `SELECT s.project_id
         FROM sessions s
         INNER JOIN project_members pm
           ON pm.project_id = s.project_id
          AND pm.id = ?
         WHERE s.id = ?
           AND s.project_id IS NOT NULL`
      )
      .get(binding.projectMemberId, binding.sessionId);
    if (!owner) {
      throw new Error('Session binding requires a ProjectMember from the Session project');
    }
    db.insert(sessionBindings).values(binding).run();
  })();
}

export function getSessionBinding(db: Db, sessionId: string, projectMemberId: string): SessionBinding | null {
  const row = db
    .select()
    .from(sessionBindings)
    .where(and(eq(sessionBindings.sessionId, sessionId), eq(sessionBindings.projectMemberId, projectMemberId)))
    .get();
  return row ? rowToSessionBinding(row) : null;
}

export function listSessionBindings(db: Db, sessionId: string): SessionBinding[] {
  return db
    .select()
    .from(sessionBindings)
    .where(eq(sessionBindings.sessionId, sessionId))
    .orderBy(asc(sessionBindings.projectMemberId))
    .all()
    .map(rowToSessionBinding);
}

export function listProjectMemberBindings(db: Db, projectId: string, projectMemberId: string): SessionBinding[] {
  return db
    .select({ binding: sessionBindings })
    .from(sessionBindings)
    .innerJoin(sessions, eq(sessions.id, sessionBindings.sessionId))
    .where(and(eq(sessions.projectId, projectId), eq(sessionBindings.projectMemberId, projectMemberId)))
    .orderBy(asc(sessionBindings.sessionId))
    .all()
    .map(({ binding }) => rowToSessionBinding(binding));
}

export function updateSessionBinding(
  db: Db,
  sessionId: string,
  projectMemberId: string,
  patch: SessionBindingPatch
): SessionBinding | null {
  const values: Partial<SessionBindingRow> = { updatedAt: patch.updatedAt };
  if (patch.lifecycle !== undefined) values.lifecycle = patch.lifecycle;
  if (patch.lastHealth !== undefined) values.lastHealth = patch.lastHealth;
  db.update(sessionBindings)
    .set(values)
    .where(and(eq(sessionBindings.sessionId, sessionId), eq(sessionBindings.projectMemberId, projectMemberId)))
    .run();
  return getSessionBinding(db, sessionId, projectMemberId);
}

// Atomic leave: in one statement mark the binding 'left' and clear its current runtime, so a binding
// can never be observed 'left' while still pointing at a live native runtime session. Cursor,
// createdAt, identity, and lastHealth (the last observed state) are preserved; rejoining is a future
// explicit lifecycle transition, not a re-bind.
export function leaveSessionBinding(
  db: Db,
  sessionId: string,
  projectMemberId: string,
  updatedAt: string
): SessionBinding | null {
  db.update(sessionBindings)
    .set({ lifecycle: 'left', currentNativeRuntimeSessionId: null, updatedAt })
    .where(and(eq(sessionBindings.sessionId, sessionId), eq(sessionBindings.projectMemberId, projectMemberId)))
    .run();
  return getSessionBinding(db, sessionId, projectMemberId);
}

// Settle a live runtime's terminal exit onto its binding with a current-id CAS: in ONE statement clear the
// current runtime and record its terminal health, but ONLY when the binding still points at exactly this
// runtime. A superseded runtime whose replacement already re-owned `current` matches nothing and is a
// no-op — its late exit can neither clear the new current nor overwrite the new health. Idempotent (a
// second callback for the same runtime no longer matches once current is cleared). Cursor, lifecycle,
// createdAt, and identity are preserved; only current, lastHealth, and updatedAt move.
export function settleTerminalSessionBindingRuntime(
  db: Db,
  input: {
    sessionId: string;
    projectMemberId: string;
    terminatingRuntimeId: string;
    terminalState: MeshSessionTerminalState;
    at: string;
  }
): SessionBinding | null {
  db.update(sessionBindings)
    .set({ currentNativeRuntimeSessionId: null, lastHealth: input.terminalState, updatedAt: input.at })
    .where(
      and(
        eq(sessionBindings.sessionId, input.sessionId),
        eq(sessionBindings.projectMemberId, input.projectMemberId),
        eq(sessionBindings.currentNativeRuntimeSessionId, input.terminatingRuntimeId)
      )
    )
    .run();
  return getSessionBinding(db, input.sessionId, input.projectMemberId);
}

// A runtime is already owned by a different member — a typed signal so callers can classify the
// conflict without string-matching an Error message, and roll back their transaction on it.
export class SessionBindingRuntimeOwnershipError extends Error {
  constructor(
    readonly meshSessionId: string,
    readonly owner: string
  ) {
    super(`Native runtime session ${meshSessionId} already belongs to ${owner}`);
    this.name = 'SessionBindingRuntimeOwnershipError';
  }
}

export function replaceSessionBindingRuntime(
  sqlite: Database,
  db: Db,
  input: {
    sessionId: string;
    projectMemberId: string;
    currentNativeRuntimeSessionId: MeshSessionId | null;
    updatedAt: string;
  }
): SessionBinding | null {
  return sqlite.transaction(() => {
    if (!getSessionBinding(db, input.sessionId, input.projectMemberId)) return null;
    if (input.currentNativeRuntimeSessionId !== null) {
      const runtime = sqlite
        .query('SELECT transcript_target_id, project_member_id, state FROM mesh_sessions WHERE id = ?')
        .get(input.currentNativeRuntimeSessionId) as {
        transcript_target_id: string;
        project_member_id: string | null;
        state: MeshSessionState;
      } | null;
      if (!runtime || runtime.transcript_target_id !== input.sessionId) {
        throw new Error(
          `Native runtime session ${input.currentNativeRuntimeSessionId} does not belong to ${input.sessionId}`
        );
      }
      if (runtime.project_member_id !== null && runtime.project_member_id !== input.projectMemberId) {
        throw new SessionBindingRuntimeOwnershipError(input.currentNativeRuntimeSessionId, runtime.project_member_id);
      }
      sqlite
        .query('UPDATE mesh_sessions SET project_member_id = ?, updated_at = ? WHERE id = ?')
        .run(input.projectMemberId, input.updatedAt, input.currentNativeRuntimeSessionId);
      db.update(sessionBindings)
        .set({
          currentNativeRuntimeSessionId: input.currentNativeRuntimeSessionId,
          lastHealth: runtime.state,
          updatedAt: input.updatedAt
        })
        .where(
          and(
            eq(sessionBindings.sessionId, input.sessionId),
            eq(sessionBindings.projectMemberId, input.projectMemberId)
          )
        )
        .run();
      return getSessionBinding(db, input.sessionId, input.projectMemberId);
    }
    // Detaching the current runtime preserves the last observed health — a binding remembers the health
    // of the runtime it was last attached to (e.g. a terminal 'stopped') rather than forgetting it.
    db.update(sessionBindings)
      .set({ currentNativeRuntimeSessionId: null, updatedAt: input.updatedAt })
      .where(
        and(eq(sessionBindings.sessionId, input.sessionId), eq(sessionBindings.projectMemberId, input.projectMemberId))
      )
      .run();
    return getSessionBinding(db, input.sessionId, input.projectMemberId);
  })();
}

export function advanceSessionBindingDeliveredCursor(
  db: Db,
  sessionId: string,
  projectMemberId: string,
  seq: number,
  updatedAt: string
): SessionBinding | null {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Session binding cursor must be a non-negative integer');
  db.update(sessionBindings)
    .set({
      lastDeliveredSeq: sql`MAX(${sessionBindings.lastDeliveredSeq}, ${seq})`,
      updatedAt
    })
    .where(and(eq(sessionBindings.sessionId, sessionId), eq(sessionBindings.projectMemberId, projectMemberId)))
    .run();
  return getSessionBinding(db, sessionId, projectMemberId);
}

export function advanceSessionBindingVisibleCursor(
  db: Db,
  sessionId: string,
  projectMemberId: string,
  seq: number,
  updatedAt: string
): SessionBinding | null {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Session binding cursor must be a non-negative integer');
  db.update(sessionBindings)
    .set({
      lastVisibleSeq: sql`MAX(${sessionBindings.lastVisibleSeq}, ${seq})`,
      updatedAt
    })
    .where(and(eq(sessionBindings.sessionId, sessionId), eq(sessionBindings.projectMemberId, projectMemberId)))
    .run();
  return getSessionBinding(db, sessionId, projectMemberId);
}
