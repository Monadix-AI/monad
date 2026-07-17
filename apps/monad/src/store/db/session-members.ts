// Session-member CRUD (Track B): a session's live member bindings. Split out of sessions.ts —
// distinct entity, distinct lifecycle. See docs/proposals/project-session-decoupling.md.

import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { and, eq } from 'drizzle-orm';

import { sessionMembers } from './schema.ts';

type Db = BunSQLiteDatabase<Record<string, never>>;

type SessionMemberRow = typeof sessionMembers.$inferSelect;

// Deliberately in-process-only for now (per conventions.md rule 4): P6a wires the store layer first;
// this type gains a wire boundary (a zod schema in @monad/protocol) once P6b exposes it over a handler.
export interface SessionMember {
  sessionId: string;
  memberId: string;
  templateId: string | null;
  type: string;
  externalAgentSessionId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SessionMemberInsert {
  sessionId: string;
  memberId: string;
  templateId?: string | null;
  type: string;
  externalAgentSessionId?: string | null;
  data?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SessionMemberPatch {
  type?: string;
  externalAgentSessionId?: string | null;
  data?: Record<string, unknown>;
  updatedAt: string;
}

function rowToSessionMember(row: SessionMemberRow): SessionMember {
  return {
    sessionId: row.sessionId,
    memberId: row.memberId,
    templateId: row.templateId ?? null,
    type: row.type,
    externalAgentSessionId: row.externalAgentSessionId ?? null,
    data: JSON.parse(row.data) as Record<string, unknown>,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export function insertSessionMember(db: Db, m: SessionMemberInsert): void {
  db.insert(sessionMembers)
    .values({
      sessionId: m.sessionId,
      memberId: m.memberId,
      templateId: m.templateId ?? null,
      type: m.type,
      externalAgentSessionId: m.externalAgentSessionId ?? null,
      data: JSON.stringify(m.data ?? {}),
      createdAt: m.createdAt,
      updatedAt: m.updatedAt
    })
    .run();
}

export function listSessionMembers(db: Db, sessionId: string): SessionMember[] {
  const rows = db.select().from(sessionMembers).where(eq(sessionMembers.sessionId, sessionId)).all();
  return rows.map(rowToSessionMember);
}

export function getSessionMember(db: Db, sessionId: string, memberId: string): SessionMember | null {
  const row = db
    .select()
    .from(sessionMembers)
    .where(and(eq(sessionMembers.sessionId, sessionId), eq(sessionMembers.memberId, memberId)))
    .get();
  return row ? rowToSessionMember(row) : null;
}

export function updateSessionMember(db: Db, sessionId: string, memberId: string, patch: SessionMemberPatch): void {
  const values: Record<string, unknown> = { updatedAt: patch.updatedAt };
  if (patch.type !== undefined) values.type = patch.type;
  if (patch.externalAgentSessionId !== undefined) values.externalAgentSessionId = patch.externalAgentSessionId;
  if (patch.data !== undefined) values.data = JSON.stringify(patch.data);
  db.update(sessionMembers)
    .set(values)
    .where(and(eq(sessionMembers.sessionId, sessionId), eq(sessionMembers.memberId, memberId)))
    .run();
}

export function deleteSessionMember(db: Db, sessionId: string, memberId: string): void {
  db.delete(sessionMembers)
    .where(and(eq(sessionMembers.sessionId, sessionId), eq(sessionMembers.memberId, memberId)))
    .run();
}

export function deleteSessionMembers(db: Db, sessionId: string): void {
  db.delete(sessionMembers).where(eq(sessionMembers.sessionId, sessionId)).run();
}
