import type { Database } from 'bun:sqlite';
import type {
  EventId,
  OperationSource,
  ProjectMemberId,
  SessionId,
  SessionPlan,
  SessionPlanTodo,
  SessionPlanTodoId,
  SessionPlanTodoPatch,
  SessionPlanTodoResponse,
  SessionPlanTodoStatus
} from '@monad/protocol';
import type {
  SessionPlanActor,
  SessionPlanAuditOutcome,
  SessionPlanAuditRecord,
  SessionPlanMutationContext,
  SessionPlanMutationErrorCode,
  SessionPlanMutationEvent,
  SessionPlanMutationResult,
  SessionPlanMutationSuccess,
  SessionPlanOperation
} from './session-plan-mutations.ts';

import {
  deleteSessionPlanTodoResponseSchema,
  sessionPlanSchema,
  sessionPlanTodoRemovedPayloadSchema,
  sessionPlanTodoResponseSchema,
  sessionPlanTodoSchema,
  sessionPlanTodoUpsertedPayloadSchema
} from '@monad/protocol';

import { createSessionPlanMutationSupport, sessionPlanMutationFingerprint } from './session-plan-mutations.ts';

type UpsertEvent = Extract<SessionPlanMutationEvent, { type: 'session.plan.todo_upserted' }>;
type RemovedEvent = Extract<SessionPlanMutationEvent, { type: 'session.plan.todo_removed' }>;

export type {
  SessionPlanActor,
  SessionPlanAuditRecord,
  SessionPlanHumanAttribution,
  SessionPlanMutationResult,
  SessionPlanProjectMemberAttribution
} from './session-plan-mutations.ts';

interface TodoRow {
  id: string;
  session_id: string;
  text: string;
  status: string;
  assignee_project_member_id: string | null;
  version: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

interface AddTodoInput {
  sessionId: SessionId;
  requestId: string;
  todoId: SessionPlanTodoId;
  eventId: EventId;
  text: string;
  status?: SessionPlanTodoStatus;
  assigneeProjectMemberId?: ProjectMemberId;
  actor: SessionPlanActor;
  at: string;
}

interface UpdateTodoInput {
  sessionId: SessionId;
  todoId: SessionPlanTodoId;
  requestId: string;
  eventId: EventId;
  expectedVersion: number;
  patch: SessionPlanTodoPatch;
  actor: SessionPlanActor;
  at: string;
}

interface DeleteTodoInput {
  sessionId: SessionId;
  todoId: SessionPlanTodoId;
  requestId: string;
  eventId: EventId;
  expectedVersion: number;
  actor: SessionPlanActor;
  at: string;
}

function rowToTodo(row: TodoRow): SessionPlanTodo {
  return sessionPlanTodoSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    text: row.text,
    status: row.status,
    ...(row.assignee_project_member_id ? { assigneeProjectMemberId: row.assignee_project_member_id } : {}),
    version: row.version,
    createdBy: JSON.parse(row.created_by),
    updatedBy: JSON.parse(row.updated_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

export function createSessionPlanStore(sqlite: Database) {
  const mutations = createSessionPlanMutationSupport(sqlite);
  const getTodo = (sessionId: SessionId, todoId: SessionPlanTodoId): SessionPlanTodo | null => {
    const row = sqlite
      .query<TodoRow, [SessionId, SessionPlanTodoId]>(
        'SELECT * FROM session_plan_todos WHERE session_id = ? AND id = ?'
      )
      .get(sessionId, todoId);
    return row ? rowToTodo(row) : null;
  };

  const listTodos = (sessionId: SessionId): SessionPlanTodo[] =>
    sqlite
      .query<TodoRow, [SessionId]>('SELECT * FROM session_plan_todos WHERE session_id = ? ORDER BY created_at, id')
      .all(sessionId)
      .map(rowToTodo);

  const get = (sessionId: SessionId): SessionPlan | null => {
    const exists = sqlite
      .query<{ present: number }, [SessionId]>('SELECT 1 AS present FROM session_plans WHERE session_id = ?')
      .get(sessionId);
    return exists ? sessionPlanSchema.parse({ sessionId, todos: listTodos(sessionId) }) : null;
  };

  const listAudit = (sessionId: SessionId): SessionPlanAuditRecord[] =>
    sqlite
      .query<Record<string, unknown>, [SessionId]>(
        'SELECT * FROM session_plan_audit_log WHERE session_id = ? ORDER BY rowid'
      )
      .all(sessionId)
      .map((row) => ({
        id: row.id as string,
        sessionId: row.session_id as SessionId,
        requestId: row.request_id as string,
        operation: row.operation as SessionPlanOperation,
        todoId: row.todo_id as SessionPlanTodoId | null,
        source: JSON.parse(row.source as string) as OperationSource,
        projectMemberId: row.project_member_id as ProjectMemberId | null,
        resourceVersion: row.resource_version as number | null,
        outcome: row.outcome as SessionPlanAuditOutcome,
        errorCode: row.error_code as SessionPlanMutationErrorCode | null,
        createdAt: row.created_at as string
      }));

  const addTodo = (input: AddTodoInput): SessionPlanMutationResult<SessionPlanTodoResponse> =>
    sqlite.transaction(() => {
      const context: SessionPlanMutationContext = {
        ...input,
        operation: 'add',
        todoId: input.todoId,
        // The handler generates todo/event ids after parsing. Retries may also cross transports, so
        // fingerprint only the client command and stable project-member identity.
        fingerprint: sessionPlanMutationFingerprint({
          operation: 'add',
          sessionId: input.sessionId,
          text: input.text,
          status: input.status ?? 'pending',
          assigneeProjectMemberId: input.assigneeProjectMemberId,
          actorKind: input.actor.kind,
          actorProjectMemberId: input.actor.attribution.projectMemberId
        })
      };
      const invalid = mutations.validateContext(context, input.assigneeProjectMemberId);
      if (invalid) return mutations.reject<SessionPlanTodoResponse>(context, invalid);
      const repeated = mutations.replay(context, (value) => sessionPlanTodoResponseSchema.parse(value));
      if (repeated) return repeated;
      const todo = sessionPlanTodoSchema.parse({
        id: input.todoId,
        sessionId: input.sessionId,
        text: input.text,
        status: input.status ?? 'pending',
        ...(input.assigneeProjectMemberId ? { assigneeProjectMemberId: input.assigneeProjectMemberId } : {}),
        version: 0,
        createdBy: input.actor.attribution,
        updatedBy: input.actor.attribution,
        createdAt: input.at,
        updatedAt: input.at
      });
      sqlite
        .query(
          `INSERT INTO session_plans (session_id, created_at, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at`
        )
        .run(input.sessionId, input.at, input.at);
      sqlite
        .query(
          `INSERT INTO session_plan_todos
           (id, session_id, text, status, assignee_project_member_id, version,
            created_by, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          todo.id,
          todo.sessionId,
          todo.text,
          todo.status,
          todo.assigneeProjectMemberId ?? null,
          todo.version,
          JSON.stringify(todo.createdBy),
          JSON.stringify(todo.updatedBy),
          todo.createdAt,
          todo.updatedAt
        );
      const response = sessionPlanTodoResponseSchema.parse({ todo });
      const event: UpsertEvent = {
        id: input.eventId,
        type: 'session.plan.todo_upserted',
        payload: sessionPlanTodoUpsertedPayloadSchema.parse({ sessionId: input.sessionId, todo }),
        at: input.at
      };
      mutations.save(context, { ok: true, response, event, resourceVersion: 0 });
      mutations.audit(context, 'applied', null, 0);
      const result: SessionPlanMutationSuccess<SessionPlanTodoResponse> = {
        ok: true,
        replayed: false,
        response,
        event
      };
      return result;
    })();

  const updateTodo = (input: UpdateTodoInput): SessionPlanMutationResult<SessionPlanTodoResponse> =>
    sqlite.transaction(() => {
      const context: SessionPlanMutationContext = {
        ...input,
        operation: 'update',
        todoId: input.todoId,
        fingerprint: sessionPlanMutationFingerprint({
          operation: 'update',
          sessionId: input.sessionId,
          todoId: input.todoId,
          expectedVersion: input.expectedVersion,
          patch: input.patch,
          actorKind: input.actor.kind,
          actorProjectMemberId: input.actor.attribution.projectMemberId
        })
      };
      const invalid = mutations.validateContext(context, input.patch.assigneeProjectMemberId);
      if (invalid) return mutations.reject<SessionPlanTodoResponse>(context, invalid);
      const repeated = mutations.replay(context, (value) => sessionPlanTodoResponseSchema.parse(value));
      if (repeated) return repeated;
      const current = getTodo(input.sessionId, input.todoId);
      if (!current) return mutations.reject<SessionPlanTodoResponse>(context, 'todo_not_found');
      if (current.version !== input.expectedVersion) {
        return mutations.reject<SessionPlanTodoResponse>(context, 'version_conflict', current.version);
      }
      const todo = sessionPlanTodoSchema.parse({
        ...current,
        ...input.patch,
        ...(input.patch.assigneeProjectMemberId === null ? { assigneeProjectMemberId: undefined } : {}),
        version: current.version + 1,
        updatedBy: input.actor.attribution,
        updatedAt: input.at
      });
      const changed = sqlite
        .query(
          `UPDATE session_plan_todos
           SET text = ?, status = ?, assignee_project_member_id = ?, version = ?, updated_by = ?, updated_at = ?
           WHERE session_id = ? AND id = ? AND version = ?`
        )
        .run(
          todo.text,
          todo.status,
          todo.assigneeProjectMemberId ?? null,
          todo.version,
          JSON.stringify(todo.updatedBy),
          todo.updatedAt,
          input.sessionId,
          input.todoId,
          input.expectedVersion
        ).changes;
      if (changed !== 1) {
        const latest = getTodo(input.sessionId, input.todoId);
        return mutations.reject<SessionPlanTodoResponse>(
          context,
          latest ? 'version_conflict' : 'todo_not_found',
          latest?.version
        );
      }
      sqlite.query('UPDATE session_plans SET updated_at = ? WHERE session_id = ?').run(input.at, input.sessionId);
      const response = sessionPlanTodoResponseSchema.parse({ todo });
      const event: UpsertEvent = {
        id: input.eventId,
        type: 'session.plan.todo_upserted',
        payload: sessionPlanTodoUpsertedPayloadSchema.parse({ sessionId: input.sessionId, todo }),
        at: input.at
      };
      mutations.save(context, { ok: true, response, event, resourceVersion: todo.version });
      mutations.audit(context, 'applied', null, todo.version);
      const result: SessionPlanMutationSuccess<SessionPlanTodoResponse> = {
        ok: true,
        replayed: false,
        response,
        event
      };
      return result;
    })();

  const deleteTodo = (
    input: DeleteTodoInput
  ): SessionPlanMutationResult<ReturnType<typeof deleteSessionPlanTodoResponseSchema.parse>> =>
    sqlite.transaction(() => {
      const context: SessionPlanMutationContext = {
        ...input,
        operation: 'delete',
        todoId: input.todoId,
        fingerprint: sessionPlanMutationFingerprint({
          operation: 'delete',
          sessionId: input.sessionId,
          todoId: input.todoId,
          expectedVersion: input.expectedVersion,
          actorKind: input.actor.kind,
          actorProjectMemberId: input.actor.attribution.projectMemberId
        })
      };
      const invalid = mutations.validateContext(context);
      if (invalid) {
        return mutations.reject<ReturnType<typeof deleteSessionPlanTodoResponseSchema.parse>>(context, invalid);
      }
      const repeated = mutations.replay(context, (value) => deleteSessionPlanTodoResponseSchema.parse(value));
      if (repeated) return repeated;
      const current = getTodo(input.sessionId, input.todoId);
      if (!current) {
        return mutations.reject<ReturnType<typeof deleteSessionPlanTodoResponseSchema.parse>>(
          context,
          'todo_not_found'
        );
      }
      if (current.version !== input.expectedVersion) {
        return mutations.reject<ReturnType<typeof deleteSessionPlanTodoResponseSchema.parse>>(
          context,
          'version_conflict',
          current.version
        );
      }
      const removedVersion = current.version + 1;
      const changed = sqlite
        .query('DELETE FROM session_plan_todos WHERE session_id = ? AND id = ? AND version = ?')
        .run(input.sessionId, input.todoId, input.expectedVersion).changes;
      if (changed !== 1) {
        const latest = getTodo(input.sessionId, input.todoId);
        return mutations.reject<ReturnType<typeof deleteSessionPlanTodoResponseSchema.parse>>(
          context,
          latest ? 'version_conflict' : 'todo_not_found',
          latest?.version
        );
      }
      sqlite.query('UPDATE session_plans SET updated_at = ? WHERE session_id = ?').run(input.at, input.sessionId);
      const response = deleteSessionPlanTodoResponseSchema.parse({ deleted: true, todoId: input.todoId });
      const event: RemovedEvent = {
        id: input.eventId,
        type: 'session.plan.todo_removed',
        payload: sessionPlanTodoRemovedPayloadSchema.parse({
          sessionId: input.sessionId,
          todoId: input.todoId,
          version: removedVersion
        }),
        at: input.at
      };
      mutations.save(context, { ok: true, response, event, resourceVersion: removedVersion });
      mutations.audit(context, 'applied', null, removedVersion);
      const result: SessionPlanMutationSuccess<ReturnType<typeof deleteSessionPlanTodoResponseSchema.parse>> = {
        ok: true,
        replayed: false,
        response,
        event
      };
      return result;
    })();

  return {
    get,
    listTodos,
    listAudit,
    addTodo,
    updateTodo,
    deleteTodo,
    markEventPublished: mutations.markEventPublished,
    listPendingEvents: mutations.listPendingEvents
  };
}
