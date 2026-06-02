import type { Database } from 'bun:sqlite';
import type {
  EventId,
  OperationSource,
  ProjectMemberId,
  SessionId,
  SessionPlanAttribution,
  SessionPlanTodoId,
  SessionPlanTodoRemovedPayload,
  SessionPlanTodoUpsertedPayload
} from '@monad/protocol';

import { createHash } from 'node:crypto';
import {
  eventIdSchema,
  iso8601Schema,
  sessionPlanTodoRemovedPayloadSchema,
  sessionPlanTodoUpsertedPayloadSchema
} from '@monad/protocol';

export type SessionPlanOperation = 'add' | 'update' | 'delete';
export type SessionPlanMutationErrorCode =
  | 'session_not_found'
  | 'actor_not_bound'
  | 'assignee_not_found'
  | 'todo_not_found'
  | 'version_conflict'
  | 'idempotency_conflict';
export type SessionPlanAuditOutcome = 'applied' | 'replayed' | 'rejected';
export type SessionPlanHumanAttribution = Omit<SessionPlanAttribution, 'projectMemberId'> & {
  projectMemberId?: never;
};
export type SessionPlanProjectMemberAttribution = Omit<SessionPlanAttribution, 'projectMemberId'> & {
  projectMemberId: ProjectMemberId;
};
export type SessionPlanActor =
  | { kind: 'human'; attribution: SessionPlanHumanAttribution }
  | { kind: 'project_member'; attribution: SessionPlanProjectMemberAttribution };

export interface SessionPlanAuditRecord {
  id: string;
  sessionId: SessionId;
  requestId: string;
  operation: SessionPlanOperation;
  todoId: SessionPlanTodoId | null;
  source: OperationSource;
  projectMemberId: ProjectMemberId | null;
  resourceVersion: number | null;
  outcome: SessionPlanAuditOutcome;
  errorCode: SessionPlanMutationErrorCode | null;
  createdAt: string;
}

type UpsertEvent = {
  id: EventId;
  type: 'session.plan.todo_upserted';
  payload: SessionPlanTodoUpsertedPayload;
  at: string;
};
type RemovedEvent = {
  id: EventId;
  type: 'session.plan.todo_removed';
  payload: SessionPlanTodoRemovedPayload;
  at: string;
};
export type SessionPlanMutationEvent = UpsertEvent | RemovedEvent;

export type SessionPlanMutationSuccess<T> = {
  ok: true;
  replayed: boolean;
  response: T;
  event: SessionPlanMutationEvent | null;
};
type MutationFailure = {
  ok: false;
  replayed: boolean;
  code: SessionPlanMutationErrorCode;
  currentVersion?: number;
};
export type SessionPlanMutationResult<T> = SessionPlanMutationSuccess<T> | MutationFailure;

export interface SessionPlanMutationContext {
  sessionId: SessionId;
  requestId: string;
  operation: SessionPlanOperation;
  todoId: SessionPlanTodoId | null;
  actor: SessionPlanActor;
  at: string;
  fingerprint: string;
}

type PersistedMutation =
  | { ok: true; response: unknown; event: SessionPlanMutationEvent; resourceVersion: number }
  | { ok: false; code: SessionPlanMutationErrorCode; currentVersion?: number };

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

export function sessionPlanMutationFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function parseStoredEvent(row: {
  id: string;
  type: string;
  payload: string;
  created_at: string;
}): SessionPlanMutationEvent {
  const common = { id: eventIdSchema.parse(row.id), at: iso8601Schema.parse(row.created_at) };
  const payload = JSON.parse(row.payload);
  if (row.type === 'session.plan.todo_upserted') {
    return { ...common, type: row.type, payload: sessionPlanTodoUpsertedPayloadSchema.parse(payload) };
  }
  if (row.type === 'session.plan.todo_removed') {
    return { ...common, type: row.type, payload: sessionPlanTodoRemovedPayloadSchema.parse(payload) };
  }
  throw new Error(`unknown persisted session plan event type: ${row.type}`);
}

function eventTodoId(event: SessionPlanMutationEvent): SessionPlanTodoId {
  return event.type === 'session.plan.todo_upserted' ? event.payload.todo.id : event.payload.todoId;
}

export function createSessionPlanMutationSupport(sqlite: Database) {
  const audit = (
    context: SessionPlanMutationContext,
    outcome: SessionPlanAuditOutcome,
    errorCode: SessionPlanMutationErrorCode | null,
    resourceVersion: number | null
  ): void => {
    sqlite
      .query(
        `INSERT INTO session_plan_audit_log
         (id, session_id, request_id, operation, todo_id, source, project_member_id,
          resource_version, outcome, error_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        context.sessionId,
        context.requestId,
        context.operation,
        context.todoId,
        JSON.stringify(context.actor.attribution.source),
        context.actor.attribution.projectMemberId ?? null,
        resourceVersion,
        outcome,
        errorCode,
        context.at
      );
  };

  const replay = <T>(
    context: SessionPlanMutationContext,
    parseResponse: (value: unknown) => T
  ): SessionPlanMutationResult<T> | null => {
    const row = sqlite
      .query<{ command_fingerprint: string; result: string }, [SessionId, string]>(
        'SELECT command_fingerprint, result FROM session_plan_mutations WHERE session_id = ? AND request_id = ?'
      )
      .get(context.sessionId, context.requestId);
    if (!row) return null;
    if (row.command_fingerprint !== context.fingerprint) {
      audit(context, 'rejected', 'idempotency_conflict', null);
      return { ok: false, replayed: false, code: 'idempotency_conflict' };
    }
    const stored = JSON.parse(row.result) as PersistedMutation;
    if (!stored.ok) {
      audit(context, 'replayed', stored.code, stored.currentVersion ?? null);
      return {
        ok: false,
        replayed: true,
        code: stored.code,
        ...(stored.currentVersion === undefined ? {} : { currentVersion: stored.currentVersion })
      };
    }
    audit({ ...context, todoId: eventTodoId(stored.event) }, 'replayed', null, stored.resourceVersion);
    const publication = sqlite
      .query<{ published_at: string | null }, [EventId]>('SELECT published_at FROM session_plan_events WHERE id = ?')
      .get(stored.event.id);
    return {
      ok: true,
      replayed: true,
      response: parseResponse(stored.response),
      event: !publication || publication.published_at === null ? stored.event : null
    };
  };

  const save = (context: SessionPlanMutationContext, result: PersistedMutation): void => {
    sqlite
      .query(
        `INSERT INTO session_plan_mutations
         (session_id, request_id, operation, command_fingerprint, result, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        context.sessionId,
        context.requestId,
        context.operation,
        context.fingerprint,
        JSON.stringify(result),
        context.at
      );
    if (result.ok) {
      sqlite
        .query(
          `INSERT INTO session_plan_events
           (id, session_id, request_id, type, payload, created_at, published_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`
        )
        .run(
          result.event.id,
          context.sessionId,
          context.requestId,
          result.event.type,
          JSON.stringify(result.event.payload),
          result.event.at
        );
    }
  };

  const markEventPublished = (eventId: EventId, at: string): boolean =>
    sqlite
      .query('UPDATE session_plan_events SET published_at = ? WHERE id = ? AND published_at IS NULL')
      .run(at, eventId).changes === 1;

  const listPendingEvents = (limit = 100): SessionPlanMutationEvent[] => {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 1000));
    return sqlite
      .query<{ id: string; type: string; payload: string; created_at: string }, [number]>(
        `SELECT id, type, payload, created_at
         FROM session_plan_events
         WHERE published_at IS NULL
         ORDER BY sequence
         LIMIT ?`
      )
      .all(boundedLimit)
      .map(parseStoredEvent);
  };

  const reject = <T>(
    context: SessionPlanMutationContext,
    code: SessionPlanMutationErrorCode,
    currentVersion?: number
  ): SessionPlanMutationResult<T> => {
    const stored: PersistedMutation = {
      ok: false,
      code,
      ...(currentVersion === undefined ? {} : { currentVersion })
    };
    const occupied = sqlite
      .query<{ present: number }, [SessionId, string]>(
        'SELECT 1 AS present FROM session_plan_mutations WHERE session_id = ? AND request_id = ?'
      )
      .get(context.sessionId, context.requestId);
    if (!occupied) save(context, stored);
    audit(context, 'rejected', code, currentVersion ?? null);
    return { ...stored, replayed: false };
  };

  const validateContext = (
    context: SessionPlanMutationContext,
    assigneeProjectMemberId?: ProjectMemberId | null
  ): SessionPlanMutationErrorCode | null => {
    const session = sqlite
      .query<{ project_id: string | null }, [SessionId]>('SELECT project_id FROM sessions WHERE id = ?')
      .get(context.sessionId);
    if (!session) return 'session_not_found';
    if (context.actor.kind !== 'human' && context.actor.kind !== 'project_member') return 'actor_not_bound';
    if (context.actor.kind === 'human' && context.actor.attribution.projectMemberId) return 'actor_not_bound';
    if (context.actor.kind === 'project_member') {
      const projectMemberId = context.actor.attribution.projectMemberId;
      if (!projectMemberId) return 'actor_not_bound';
      const actor = sqlite
        .query<{ present: number }, [SessionId, ProjectMemberId]>(
          `SELECT 1 AS present
           FROM session_bindings sb
           JOIN sessions s ON s.id = sb.session_id
           JOIN project_members pm ON pm.project_id = s.project_id AND pm.id = sb.project_member_id
           WHERE sb.session_id = ? AND sb.project_member_id = ?
             AND sb.lifecycle = 'active' AND pm.lifecycle = 'enabled'`
        )
        .get(context.sessionId, projectMemberId);
      if (!actor) return 'actor_not_bound';
    }
    if (assigneeProjectMemberId) {
      const assignee = sqlite
        .query<{ present: number }, [SessionId, ProjectMemberId]>(
          `SELECT 1 AS present
           FROM sessions s
           JOIN project_members pm ON pm.project_id = s.project_id
           WHERE s.id = ? AND pm.id = ? AND pm.lifecycle = 'enabled'`
        )
        .get(context.sessionId, assigneeProjectMemberId);
      if (!assignee) return 'assignee_not_found';
    }
    return null;
  };

  return { audit, replay, save, reject, validateContext, markEventPublished, listPendingEvents };
}
