import type {
  AddSessionPlanTodoRequest,
  DeleteSessionPlanTodoResponse,
  Event,
  OperationSource,
  SessionId,
  SessionPlan,
  SessionPlanTodo,
  SessionPlanTodoId,
  SessionPlanTodoPatch,
  UpdateSessionPlanTodoRequest
} from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';
import type { EventBus } from '#/services/event-bus.ts';
import type { Store } from '#/store/db/index.ts';
import type { SessionPlanActor, SessionPlanMutationErrorCode } from '#/store/db/session-plan-mutations.ts';

import { newId, sessionPlanSchema } from '@monad/protocol';

import { HandlerError } from '#/handlers/handler-error.ts';
import { assertSessionWriteAuthority } from '#/handlers/session/transport-authority.ts';

// Maps every SessionPlanMutationErrorCode to a HandlerError kind. session_not_found/todo_not_found
// are both "the thing this request names doesn't exist" (not_found); actor_not_bound is a caller who
// isn't currently an active member of the session (forbidden, not invalid — the request shape is
// fine, the actor's standing isn't); assignee_not_found is a bad request body (invalid); the two CAS
// failure modes are both conflict.
const MUTATION_ERROR_KIND: Record<SessionPlanMutationErrorCode, HandlerError['kind']> = {
  session_not_found: 'not_found',
  actor_not_bound: 'forbidden',
  assignee_not_found: 'invalid',
  todo_not_found: 'not_found',
  version_conflict: 'conflict',
  idempotency_conflict: 'conflict'
};

function mutationError(code: SessionPlanMutationErrorCode, currentVersion?: number): HandlerError {
  const message = currentVersion === undefined ? code : `${code} (current version ${currentVersion})`;
  return new HandlerError(MUTATION_ERROR_KIND[code], message, code);
}

type StoredPlanEvent = { id: Event['id']; type: Event['type']; payload: Event['payload']; at: string };

/**
 * Publishes one outbox row's event to the bus and marks it published — never the reverse order.
 * `markEventPublished` only runs once `bus.publish` returns, so a throw from `publish` (a bad
 * payload, a synchronous subscriber throwing) leaves the row pending and propagates: the caller
 * decides whether to stop or keep going, and the row is never marked delivered without actually
 * having been handed to the bus.
 */
function publishAndMarkPlanEvent(store: Store, bus: EventBus, sessionId: SessionId, event: StoredPlanEvent): void {
  bus.publish({ id: event.id, sessionId, type: event.type, actorAgentId: null, payload: event.payload, at: event.at });
  store.sessionPlans.markEventPublished(event.id, new Date().toISOString());
}

/**
 * Publishes a durable session-plan event and marks its outbox row published — only when the
 * mutation actually produced one. A replayed mutation whose event was already published on a
 * prior attempt returns `event: null` from the store; skipping the publish here is what keeps
 * replay from re-delivering an event a client already saw.
 */
function publishPlanEvent(store: Store, bus: EventBus, sessionId: SessionId, event: StoredPlanEvent | null): void {
  if (!event) return;
  publishAndMarkPlanEvent(store, bus, sessionId, event);
}

/**
 * Boot-time outbox drain: republishes every session-plan event that was durably saved but never
 * confirmed published (a crash between `bus.publish` and `markEventPublished`, or a daemon
 * restart with subscribers gone). Reads oldest-first, one `batchSize`-bounded page at a time,
 * and keeps re-reading pending rows until the outbox is empty — a single `listPendingEvents`
 * call only ever returns up to `batchSize` rows, so a one-shot read would silently leave
 * anything beyond that page unpublished until the *next* restart. Publishes in strict sequence
 * order, across batches, so a client that reconnects sees todo history unfold in the order it
 * actually happened. Never touches fan-out/wake/scheduler — these are control-plane-only events
 * (see event-table.ts). A publish failure aborts immediately: the failing row and every row
 * still queued (this batch and all later ones) stay pending, matching the single-event path.
 */
export function drainPendingSessionPlanEvents(store: Store, bus: EventBus, batchSize?: number): number {
  let drained = 0;
  for (;;) {
    const batch = store.sessionPlans.listPendingEvents(batchSize);
    if (batch.length === 0) return drained;
    for (const event of batch) {
      publishAndMarkPlanEvent(store, bus, event.payload.sessionId, event);
      drained++;
    }
  }
}

// ── Core mutations: transport-agnostic, no authority check. Shared by the human-facing handlers
// below (which isolate scheduler-owned automation sessions) and the managed-agent native-agent
// service (whose authority comes from `requireManagedBinding`'s current-runtime fence).

export function listPlanCore(store: Store, sessionId: SessionId): { plan: SessionPlan } {
  const plan = store.sessionPlans.get(sessionId) ?? sessionPlanSchema.parse({ sessionId, todos: [] });
  return { plan };
}

export function addPlanTodoCore(
  store: Store,
  bus: EventBus,
  sessionId: SessionId,
  actor: SessionPlanActor,
  body: Omit<AddSessionPlanTodoRequest, 'sessionId'>
): { todo: SessionPlanTodo } {
  const result = store.sessionPlans.addTodo({
    sessionId,
    todoId: newId('todo'),
    eventId: newId('evt'),
    actor,
    at: new Date().toISOString(),
    ...body
  });
  if (!result.ok) throw mutationError(result.code, result.currentVersion);
  publishPlanEvent(store, bus, sessionId, result.event);
  return result.response;
}

export function updatePlanTodoCore(
  store: Store,
  bus: EventBus,
  sessionId: SessionId,
  actor: SessionPlanActor,
  todoId: SessionPlanTodoId,
  body: Omit<UpdateSessionPlanTodoRequest, 'sessionId' | 'todoId'>
): { todo: SessionPlanTodo } {
  const result = store.sessionPlans.updateTodo({
    sessionId,
    todoId,
    eventId: newId('evt'),
    actor,
    at: new Date().toISOString(),
    ...body
  });
  if (!result.ok) throw mutationError(result.code, result.currentVersion);
  publishPlanEvent(store, bus, sessionId, result.event);
  return result.response;
}

export function deletePlanTodoCore(
  store: Store,
  bus: EventBus,
  sessionId: SessionId,
  actor: SessionPlanActor,
  todoId: SessionPlanTodoId,
  body: { requestId: string; expectedVersion: number }
): DeleteSessionPlanTodoResponse {
  const result = store.sessionPlans.deleteTodo({
    sessionId,
    todoId,
    eventId: newId('evt'),
    actor,
    at: new Date().toISOString(),
    ...body
  });
  if (!result.ok) throw mutationError(result.code, result.currentVersion);
  publishPlanEvent(store, bus, sessionId, result.event);
  return result.response;
}

// ── Human/operator-facing handlers: reachable over public REST (`/v1/sessions/:id/plan/*`) and
// the JSON-RPC transports. Authority is checked before any plan/member/assignee read. `origin` is
// a fully-built `OperationSource` — the transport layer constructs it server-side (HTTP:
// `buildOperationSource` in the sessions controller, same as `session.create`; RPC: `nativeOrigin`
// in methods.ts), never trusting client-declared transport/instanceId. The wire never accepts an
// `actor` or `projectMemberId` argument at all, so a caller cannot self-attribute as a project
// member or forge another session's identity — `kind: 'human'` is hardcoded here, not a choice.

export function createSessionPlanHandlers(ctx: SessionContext) {
  const {
    deps: { store, bus }
  } = ctx;

  function humanActor(origin: OperationSource): SessionPlanActor {
    return { kind: 'human', attribution: { source: origin } };
  }

  return {
    listPlan({ id }: { id: SessionId }): { plan: SessionPlan } {
      const session = ctx.requireSession(id);
      assertSessionWriteAuthority(session);
      return listPlanCore(store, id);
    },

    addPlanTodo(args: { id: SessionId; origin: OperationSource } & Omit<AddSessionPlanTodoRequest, 'sessionId'>): {
      todo: SessionPlanTodo;
    } {
      const { id, origin, ...body } = args;
      const session = ctx.requireSession(id);
      assertSessionWriteAuthority(session);
      return addPlanTodoCore(store, bus, id, humanActor(origin), body);
    },

    updatePlanTodo(
      args: {
        id: SessionId;
        todoId: SessionPlanTodoId;
        origin: OperationSource;
        patch: SessionPlanTodoPatch;
      } & Omit<UpdateSessionPlanTodoRequest, 'sessionId' | 'todoId' | 'patch'>
    ): { todo: SessionPlanTodo } {
      const { id, todoId, origin, ...body } = args;
      const session = ctx.requireSession(id);
      assertSessionWriteAuthority(session);
      return updatePlanTodoCore(store, bus, id, humanActor(origin), todoId, body);
    },

    deletePlanTodo(args: {
      id: SessionId;
      todoId: SessionPlanTodoId;
      origin: OperationSource;
      requestId: string;
      expectedVersion: number;
    }): DeleteSessionPlanTodoResponse {
      const { id, todoId, origin, ...body } = args;
      const session = ctx.requireSession(id);
      assertSessionWriteAuthority(session);
      return deletePlanTodoCore(store, bus, id, humanActor(origin), todoId, body);
    }
  };
}
