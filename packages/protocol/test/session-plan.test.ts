import type { SessionId } from '../src/ids.ts';
import type { SessionPlanTodoId } from '../src/session-plan.ts';

import { expect, test } from 'bun:test';

import {
  addSessionPlanTodoRequestSchema,
  deleteSessionPlanTodoRequestSchema,
  SESSION_PLAN_TODO_TEXT_MAX,
  sessionPlanTodoSchema,
  updateSessionPlanTodoRequestSchema
} from '../src/session-plan.ts';

const source = { surface: 'web' as const, client: 'monad-web', transport: 'http' as const };
const validTodo = {
  id: 'todo_000000000001' as SessionPlanTodoId,
  sessionId: 'ses_000000000001' as SessionId,
  text: 'write the migration',
  status: 'pending' as const,
  version: 0,
  createdBy: { source },
  updatedBy: { source },
  createdAt: '2026-07-27T00:00:00.000Z',
  updatedAt: '2026-07-27T00:00:00.000Z'
};

test('a todo round-trips its exact contract and rejects malformed shapes', () => {
  const parsed = sessionPlanTodoSchema.safeParse(validTodo);
  expect({
    roundTrip: parsed.success ? parsed.data : null,
    missingVersion: sessionPlanTodoSchema.safeParse({ ...validTodo, version: undefined }).success,
    negativeVersion: sessionPlanTodoSchema.safeParse({ ...validTodo, version: -1 }).success,
    unknownStatus: sessionPlanTodoSchema.safeParse({ ...validTodo, status: 'archived' }).success,
    cancelledStatus: sessionPlanTodoSchema.safeParse({ ...validTodo, status: 'cancelled' }).success,
    oversizedText: sessionPlanTodoSchema.safeParse({ ...validTodo, text: 'x'.repeat(SESSION_PLAN_TODO_TEXT_MAX + 1) })
      .success,
    extraKey: sessionPlanTodoSchema.safeParse({ ...validTodo, surprise: 1 }).success
  }).toEqual({
    roundTrip: validTodo,
    missingVersion: false,
    negativeVersion: false,
    unknownStatus: false,
    cancelledStatus: false,
    oversizedText: false,
    extraKey: false
  });
});

test('adding a todo requires an idempotency key and bounded text', () => {
  const base = { sessionId: 'ses_000000000001', text: 'do it' };
  expect({
    withKey: addSessionPlanTodoRequestSchema.safeParse({ ...base, requestId: 'idem_000000000001' }).success,
    missingKey: addSessionPlanTodoRequestSchema.safeParse(base).success,
    oversizedText: addSessionPlanTodoRequestSchema.safeParse({
      ...base,
      requestId: 'idem_000000000001',
      text: 'x'.repeat(SESSION_PLAN_TODO_TEXT_MAX + 1)
    }).success
  }).toEqual({ withKey: true, missingKey: false, oversizedText: false });
});

test('updating a todo requires a CAS version, an idempotency key, and a non-empty patch', () => {
  const base = { sessionId: 'ses_000000000001', todoId: 'todo_000000000001', requestId: 'idem_000000000001' };
  expect({
    validPatch: updateSessionPlanTodoRequestSchema.safeParse({
      ...base,
      expectedVersion: 3,
      patch: { status: 'completed' }
    }).success,
    clearAssignee: updateSessionPlanTodoRequestSchema.safeParse({
      ...base,
      expectedVersion: 3,
      patch: { assigneeProjectMemberId: null }
    }).success,
    emptyPatch: updateSessionPlanTodoRequestSchema.safeParse({ ...base, expectedVersion: 3, patch: {} }).success,
    missingExpectedVersion: updateSessionPlanTodoRequestSchema.safeParse({ ...base, patch: { status: 'completed' } })
      .success,
    missingKey: updateSessionPlanTodoRequestSchema.safeParse({
      sessionId: base.sessionId,
      todoId: base.todoId,
      expectedVersion: 3,
      patch: { status: 'completed' }
    }).success
  }).toEqual({
    validPatch: true,
    clearAssignee: true,
    emptyPatch: false,
    missingExpectedVersion: false,
    missingKey: false
  });
});

test('deleting a todo requires an expected version and an idempotency key', () => {
  const base = { sessionId: 'ses_000000000001', todoId: 'todo_000000000001' };
  expect({
    valid: deleteSessionPlanTodoRequestSchema.safeParse({
      ...base,
      requestId: 'idem_000000000001',
      expectedVersion: 2
    }).success,
    missingExpectedVersion: deleteSessionPlanTodoRequestSchema.safeParse({ ...base, requestId: 'idem_000000000001' })
      .success,
    missingKey: deleteSessionPlanTodoRequestSchema.safeParse({ ...base, expectedVersion: 2 }).success
  }).toEqual({ valid: true, missingExpectedVersion: false, missingKey: false });
});
