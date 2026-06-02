import { z } from 'zod';

import { operationSourceSchema } from './domain.ts';
import {
  idempotencyKeySchema,
  iso8601Schema,
  prefixedIdSchema,
  projectMemberIdSchema,
  sessionIdSchema
} from './ids.ts';

// Optional durable SessionPlan (P0-C): a per-session to-do list the agents and operator share. Contract
// only — the daemon methods, store, and MCP proxy are wired in a later round once P0-B's ProjectMember /
// SessionBinding identity is stable (todos are attributed to a ProjectMember). The plan row is created
// lazily on first mutation; an untouched session has no plan and lists as an empty todo array.

// Kept in this file rather than ids.ts so P0-C can land without touching ids.ts while P0-B concurrently
// adds ProjectMember / SessionBinding ids there; fold into ids.ts at merge if the team prefers.
export type SessionPlanTodoId = `todo_${string}`;
export const sessionPlanTodoIdSchema: z.ZodType<SessionPlanTodoId> = prefixedIdSchema<SessionPlanTodoId>('todo');

export const SESSION_PLAN_TODO_TEXT_MAX = 4096;

export const sessionPlanTodoStatusSchema = z.enum(['pending', 'in_progress', 'completed']);
export type SessionPlanTodoStatus = z.infer<typeof sessionPlanTodoStatusSchema>;

// The assignee is a stable ProjectMember id (identity that outlives any one session), resolved
// project-scoped from the todo's session at wiring time — never treated as a global handle.

export const sessionPlanAttributionSchema = z
  .object({
    // Every mutation carries the transport/surface it arrived on (already the daemon's provenance core).
    source: operationSourceSchema,
    // Present when the actor is a project member rather than the human/operator directly.
    projectMemberId: projectMemberIdSchema.optional()
  })
  .strict();
export type SessionPlanAttribution = z.infer<typeof sessionPlanAttributionSchema>;

export const sessionPlanTodoSchema = z
  .object({
    id: sessionPlanTodoIdSchema,
    sessionId: sessionIdSchema,
    text: z.string().min(1).max(SESSION_PLAN_TODO_TEXT_MAX),
    status: sessionPlanTodoStatusSchema,
    assigneeProjectMemberId: projectMemberIdSchema.optional(),
    // Per-todo optimistic-concurrency counter. A mutation supplies the version it read; the daemon
    // rejects on mismatch (compare-and-swap) so two members editing DIFFERENT todos never clobber each
    // other — there is deliberately no global plan lock.
    version: z.number().int().nonnegative(),
    createdBy: sessionPlanAttributionSchema,
    updatedBy: sessionPlanAttributionSchema,
    createdAt: iso8601Schema,
    updatedAt: iso8601Schema
  })
  .strict();
export type SessionPlanTodo = z.infer<typeof sessionPlanTodoSchema>;

export const sessionPlanSchema = z
  .object({
    sessionId: sessionIdSchema,
    todos: z.array(sessionPlanTodoSchema)
  })
  .strict();
export type SessionPlan = z.infer<typeof sessionPlanSchema>;

// ── Method contract (list + mutations). Each mutating request carries an idempotency key so a retried
// request never creates or re-applies a duplicate, and update/delete carry the expected version for CAS.

export const listSessionPlanRequestSchema = z.object({ sessionId: sessionIdSchema }).strict();
export type ListSessionPlanRequest = z.infer<typeof listSessionPlanRequestSchema>;

export const listSessionPlanResponseSchema = z.object({ plan: sessionPlanSchema }).strict();
export type ListSessionPlanResponse = z.infer<typeof listSessionPlanResponseSchema>;

export const addSessionPlanTodoRequestSchema = z
  .object({
    sessionId: sessionIdSchema,
    requestId: idempotencyKeySchema,
    text: z.string().min(1).max(SESSION_PLAN_TODO_TEXT_MAX),
    status: sessionPlanTodoStatusSchema.optional(),
    assigneeProjectMemberId: projectMemberIdSchema.optional()
  })
  .strict();
export type AddSessionPlanTodoRequest = z.infer<typeof addSessionPlanTodoRequestSchema>;

// A patch changes at least one field; `assigneeProjectMemberId: null` clears the assignee.
export const sessionPlanTodoPatchSchema = z
  .object({
    text: z.string().min(1).max(SESSION_PLAN_TODO_TEXT_MAX).optional(),
    status: sessionPlanTodoStatusSchema.optional(),
    assigneeProjectMemberId: projectMemberIdSchema.nullable().optional()
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'update must change at least one field' });
export type SessionPlanTodoPatch = z.infer<typeof sessionPlanTodoPatchSchema>;

export const updateSessionPlanTodoRequestSchema = z
  .object({
    sessionId: sessionIdSchema,
    todoId: sessionPlanTodoIdSchema,
    requestId: idempotencyKeySchema,
    expectedVersion: z.number().int().nonnegative(),
    patch: sessionPlanTodoPatchSchema
  })
  .strict();
export type UpdateSessionPlanTodoRequest = z.infer<typeof updateSessionPlanTodoRequestSchema>;

export const deleteSessionPlanTodoRequestSchema = z
  .object({
    sessionId: sessionIdSchema,
    todoId: sessionPlanTodoIdSchema,
    requestId: idempotencyKeySchema,
    expectedVersion: z.number().int().nonnegative()
  })
  .strict();
export type DeleteSessionPlanTodoRequest = z.infer<typeof deleteSessionPlanTodoRequestSchema>;

export const sessionPlanTodoResponseSchema = z.object({ todo: sessionPlanTodoSchema }).strict();
export type SessionPlanTodoResponse = z.infer<typeof sessionPlanTodoResponseSchema>;

export const deleteSessionPlanTodoResponseSchema = z
  .object({ deleted: z.literal(true), todoId: sessionPlanTodoIdSchema })
  .strict();
export type DeleteSessionPlanTodoResponse = z.infer<typeof deleteSessionPlanTodoResponseSchema>;

// ── Session-scoped plan events. Payload contracts only; registered in the event table during wiring.
// Applying a plan event must never wake or schedule an agent — it is presentation/audit state.

export const sessionPlanTodoUpsertedPayloadSchema = z
  .object({ sessionId: sessionIdSchema, todo: sessionPlanTodoSchema })
  .strict();
export type SessionPlanTodoUpsertedPayload = z.infer<typeof sessionPlanTodoUpsertedPayloadSchema>;

export const sessionPlanTodoRemovedPayloadSchema = z
  .object({ sessionId: sessionIdSchema, todoId: sessionPlanTodoIdSchema, version: z.number().int().nonnegative() })
  .strict();
export type SessionPlanTodoRemovedPayload = z.infer<typeof sessionPlanTodoRemovedPayloadSchema>;
