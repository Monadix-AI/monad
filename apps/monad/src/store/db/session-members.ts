// Compatibility session-member storage. The canonical runtime identity/binding model is documented
// in docs/internals/agent-team-runtime/project-sessions.md.

import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { sessionMembers } from './schema.ts';

type Db = BunSQLiteDatabase<Record<string, never>>;

type SessionMemberRow = typeof sessionMembers.$inferSelect;
const sessionMemberDataSchema = z.record(z.string(), z.unknown());

// Deliberately in-process-only: public member responses use the canonical
// ProjectMember + SessionBinding schemas in @monad/protocol.
export interface SessionMember {
  sessionId: string;
  memberId: string;
  templateId: string | null;
  type: string;
  meshSessionId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SessionMemberInsert {
  sessionId: string;
  memberId: string;
  templateId?: string | null;
  type: string;
  meshSessionId?: string | null;
  data?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SessionMemberPatch {
  type?: string;
  meshSessionId?: string | null;
  data?: Record<string, unknown>;
  updatedAt: string;
}

function rowToSessionMember(row: SessionMemberRow): SessionMember {
  return {
    sessionId: row.sessionId,
    memberId: row.memberId,
    templateId: row.templateId ?? null,
    type: row.type,
    meshSessionId: row.meshSessionId ?? null,
    data: sessionMemberDataSchema.parse(JSON.parse(row.data)),
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
      meshSessionId: m.meshSessionId ?? null,
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

// Finds a session's member by its Profile-reference templateId (not its memberId). Template-backed
// members now carry a fresh per-instance memberId, so same-session invite idempotency resolves by the
// templateId field. At most one row per (session, templateId) is expected (handler-enforced).
export function getSessionMemberByTemplate(db: Db, sessionId: string, templateId: string): SessionMember | null {
  const row = db
    .select()
    .from(sessionMembers)
    .where(and(eq(sessionMembers.sessionId, sessionId), eq(sessionMembers.templateId, templateId)))
    .get();
  return row ? rowToSessionMember(row) : null;
}

export function updateSessionMember(db: Db, sessionId: string, memberId: string, patch: SessionMemberPatch): void {
  const values: Record<string, unknown> = { updatedAt: patch.updatedAt };
  if (patch.type !== undefined) values.type = patch.type;
  if (patch.meshSessionId !== undefined) values.meshSessionId = patch.meshSessionId;
  if (patch.data !== undefined) values.data = JSON.stringify(patch.data);
  db.update(sessionMembers)
    .set(values)
    .where(and(eq(sessionMembers.sessionId, sessionId), eq(sessionMembers.memberId, memberId)))
    .run();
}

export function updateSessionMemberData(
  db: Db,
  sessionId: string,
  memberId: string,
  updatedAt: string,
  update: (data: Record<string, unknown>) => Record<string, unknown>
): SessionMember | null {
  const current = getSessionMember(db, sessionId, memberId);
  if (!current) return null;
  updateSessionMember(db, sessionId, memberId, { data: update(structuredClone(current.data)), updatedAt });
  return getSessionMember(db, sessionId, memberId);
}

export function deleteSessionMember(db: Db, sessionId: string, memberId: string): void {
  db.delete(sessionMembers)
    .where(and(eq(sessionMembers.sessionId, sessionId), eq(sessionMembers.memberId, memberId)))
    .run();
}

export function deleteSessionMembers(db: Db, sessionId: string): void {
  db.delete(sessionMembers).where(eq(sessionMembers.sessionId, sessionId)).run();
}
