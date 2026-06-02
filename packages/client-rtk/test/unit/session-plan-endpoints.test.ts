// Offline wiring tests for the SessionPlan endpoints (P0-C client-rtk consumption, S4-e3-a).
// Same approach as feature-endpoints.test.ts: drive endpoints through store.dispatch against a
// fake treaty-backed client, asserting delegation, response shaping, and tag-based invalidation —
// no React render, no live daemon.
//
// Unlike a stateless echo fake, this fake carries real per-session mutable state (todos +
// idempotency ledger) so it can enforce the same idempotency/CAS contract the real daemon does
// (see apps/monad/src/store/db/session-plans.ts) — a stateless fake can only prove delegation, not
// that RTK Query's cache actually converges through invalidation, replay, and a 409 conflict.

import type { MonadClient } from '@monad/client';
import type { SessionId, SessionPlanTodoId } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  addSessionPlanTodoApi,
  deleteSessionPlanTodoApi,
  listSessionPlanApi,
  updateSessionPlanTodoApi
} from '../../src/endpoints/sessions/index.ts';
import { createMonadStore } from '../../src/index.ts';

const sessionId = 'ses_100000000000' as SessionId;
const origin = { source: { surface: 'web' as const, client: 'monad-web', transport: 'http' as const } };

interface FakeTodo {
  id: string;
  sessionId: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
  version: number;
  createdBy: typeof origin;
  updatedBy: typeof origin;
  createdAt: string;
  updatedAt: string;
}

function ok<T>(data: T): { data: T; status: number } {
  return { data, status: 200 };
}
function err(status: number, error: string, code: string): { error: { status: number; value: unknown } } {
  return { error: { status, value: { error, code } } };
}

/** A real (if minimal) stateful fake: todos keyed by id, requestId->fingerprint+result ledger. */
function fakePlanServer() {
  let nextId = 1;
  const todos = new Map<string, FakeTodo>();
  const mutations = new Map<string, { fingerprint: string; result: unknown }>();
  const mutationCallsByRequestId = new Map<string, number>();

  function bumpCalls(requestId: string): number {
    const n = (mutationCallsByRequestId.get(requestId) ?? 0) + 1;
    mutationCallsByRequestId.set(requestId, n);
    return n;
  }

  return {
    todos,
    callCountFor: (requestId: string) => mutationCallsByRequestId.get(requestId) ?? 0,
    get: () => ok({ plan: { sessionId, todos: [...todos.values()] } }),
    addTodo: (body: { requestId: string; text: string }) => {
      bumpCalls(body.requestId);
      const fingerprint = `add:${body.text}`;
      const existing = mutations.get(body.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) return err(409, 'idempotency conflict', 'CONFLICT');
        return ok(existing.result);
      }
      const now = new Date().toISOString();
      const todo: FakeTodo = {
        id: `todo_${String(nextId++).padStart(12, '0')}`,
        sessionId,
        text: body.text,
        status: 'pending',
        version: 0,
        createdBy: origin,
        updatedBy: origin,
        createdAt: now,
        updatedAt: now
      };
      todos.set(todo.id, todo);
      const result = { todo };
      mutations.set(body.requestId, { fingerprint, result });
      return ok(result);
    },
    updateTodo: (todoId: string, body: { requestId: string; expectedVersion: number; patch: { status?: string } }) => {
      bumpCalls(body.requestId);
      const fingerprint = `update:${todoId}:${body.expectedVersion}:${JSON.stringify(body.patch)}`;
      const existing = mutations.get(body.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) return err(409, 'idempotency conflict', 'CONFLICT');
        return ok(existing.result);
      }
      const current = todos.get(todoId);
      if (!current) return err(404, 'not found', 'NOT_FOUND');
      if (current.version !== body.expectedVersion) return err(409, 'version conflict', 'CONFLICT');
      const updated: FakeTodo = {
        ...current,
        ...(body.patch.status ? { status: body.patch.status as FakeTodo['status'] } : {}),
        version: current.version + 1,
        updatedBy: origin,
        updatedAt: new Date().toISOString()
      };
      todos.set(todoId, updated);
      const result = { todo: updated };
      mutations.set(body.requestId, { fingerprint, result });
      return ok(result);
    },
    deleteTodo: (todoId: string, body: { requestId: string; expectedVersion: number }) => {
      bumpCalls(body.requestId);
      const fingerprint = `delete:${todoId}:${body.expectedVersion}`;
      const existing = mutations.get(body.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) return err(409, 'idempotency conflict', 'CONFLICT');
        return ok(existing.result);
      }
      const current = todos.get(todoId);
      if (!current) return err(404, 'not found', 'NOT_FOUND');
      if (current.version !== body.expectedVersion) return err(409, 'version conflict', 'CONFLICT');
      todos.delete(todoId);
      const result = { deleted: true, todoId };
      mutations.set(body.requestId, { fingerprint, result });
      return ok(result);
    }
  };
}

function clientOverPlanServer(server: ReturnType<typeof fakePlanServer>): MonadClient {
  const client = {
    treaty: {
      v1: {
        sessions: ({ id }: { id: string }) => {
          if (id !== sessionId) throw new Error(`unexpected sessionId ${id}`);
          return {
            plan: Object.assign(
              { get: async () => server.get() },
              {
                todos: Object.assign(
                  ({ todoId }: { todoId: string }) => ({
                    patch: async (body: { expectedVersion: number; requestId: string; patch: { status?: string } }) =>
                      server.updateTodo(todoId, body),
                    delete: async (body: { requestId: string; expectedVersion: number }) =>
                      server.deleteTodo(todoId, body)
                  }),
                  { post: async (body: { requestId: string; text: string }) => server.addTodo(body) }
                )
              }
            )
          };
        }
      }
    },
    subscribeControl: () => () => {},
    streamEvents: () => () => {}
  };
  return client as unknown as MonadClient;
}

function planCacheTodos(store: ReturnType<typeof createMonadStore>): FakeTodo[] {
  const state = listSessionPlanApi.endpoints.listSessionPlan.select(sessionId)(store.getState() as never);
  return (state.data?.plan.todos ?? []) as unknown as FakeTodo[];
}

test('an empty plan issues one GET and triggers no mutation calls', async () => {
  const server = fakePlanServer();
  const store = createMonadStore({ client: clientOverPlanServer(server) });

  const res = await store.dispatch(listSessionPlanApi.endpoints.listSessionPlan.initiate(sessionId));

  expect('data' in res && res.data).toEqual({ plan: { sessionId, todos: [] } });
  expect(server.todos.size).toBe(0);
});

test('addSessionPlanTodo converges the subscribed cache from empty to one todo, and a same-requestId replay does not duplicate the server mutation or the cached todo', async () => {
  const server = fakePlanServer();
  const store = createMonadStore({ client: clientOverPlanServer(server) });

  // Subscribe to the list query so tag invalidation actually refetches into this cache entry.
  store.dispatch(listSessionPlanApi.endpoints.listSessionPlan.initiate(sessionId));
  await new Promise((r) => setTimeout(r, 0));
  expect(planCacheTodos(store)).toEqual([]);

  const first = await store.dispatch(
    addSessionPlanTodoApi.endpoints.addSessionPlanTodo.initiate({
      sessionId,
      requestId: 'idem_addplantodo01',
      text: 'Ship the client'
    })
  );
  await new Promise((r) => setTimeout(r, 0));

  expect('data' in first && first.data?.todo.text).toBe('Ship the client');
  expect(planCacheTodos(store).map((t) => t.text)).toEqual(['Ship the client']);
  expect(server.todos.size).toBe(1);

  // Replay with the identical requestId+payload: server-side mutation footprint must not grow
  // (still exactly one durable todo), and the converged cache must still show exactly one todo.
  const replay = await store.dispatch(
    addSessionPlanTodoApi.endpoints.addSessionPlanTodo.initiate({
      sessionId,
      requestId: 'idem_addplantodo01',
      text: 'Ship the client'
    })
  );
  await new Promise((r) => setTimeout(r, 0));

  expect('data' in replay && replay.data).toEqual('data' in first ? first.data : undefined);
  expect(server.todos.size).toBe(1);
  expect(planCacheTodos(store).map((t) => t.text)).toEqual(['Ship the client']);
  // The replay did reach the network twice (RTK Query does not dedupe distinct dispatches), but
  // the server-observed call count proves the *server* only ever committed once per requestId.
  expect(server.callCountFor('idem_addplantodo01')).toBe(2);
});

test('updateSessionPlanTodo converges the cache to the new version/status on success, and a conflicting CAS attempt is rejected without corrupting the cache', async () => {
  const server = fakePlanServer();
  const store = createMonadStore({ client: clientOverPlanServer(server) });
  store.dispatch(listSessionPlanApi.endpoints.listSessionPlan.initiate(sessionId));
  await new Promise((r) => setTimeout(r, 0));

  const added = await store.dispatch(
    addSessionPlanTodoApi.endpoints.addSessionPlanTodo.initiate({
      sessionId,
      requestId: 'idem_addforupdate1',
      text: 'Draft'
    })
  );
  await new Promise((r) => setTimeout(r, 0));
  const todoId = ('data' in added ? added.data?.todo.id : undefined) as SessionPlanTodoId;
  expect(todoId).toMatch(/^todo_\d{12}$/);

  const updated = await store.dispatch(
    updateSessionPlanTodoApi.endpoints.updateSessionPlanTodo.initiate({
      sessionId,
      todoId,
      requestId: 'idem_updplantodo01',
      expectedVersion: 0,
      patch: { status: 'in_progress' }
    })
  );
  await new Promise((r) => setTimeout(r, 0));

  expect('data' in updated && updated.data?.todo).toMatchObject({ status: 'in_progress', version: 1 });
  expect(planCacheTodos(store)).toHaveLength(1);
  expect(planCacheTodos(store)[0]).toMatchObject({ status: 'in_progress', version: 1 });

  // Same (now-stale) expectedVersion, a fresh requestId: this is a genuine second writer racing
  // on the old version, not a replay — the server must reject it as a version conflict, and the
  // cache must still reflect the canonical (already-updated) todo, never a speculative version.
  const conflicting = await store.dispatch(
    updateSessionPlanTodoApi.endpoints.updateSessionPlanTodo.initiate({
      sessionId,
      todoId,
      requestId: 'idem_updplantodo02',
      expectedVersion: 0,
      patch: { status: 'completed' }
    })
  );
  await new Promise((r) => setTimeout(r, 0));

  expect('error' in conflicting && (conflicting.error as { status?: number }).status).toBe(409);
  expect(planCacheTodos(store)[0]).toMatchObject({ status: 'in_progress', version: 1 });
  expect(server.todos.get(todoId)).toMatchObject({ status: 'in_progress', version: 1 });
});

test('deleteSessionPlanTodo converges the cache to empty on success', async () => {
  const server = fakePlanServer();
  const store = createMonadStore({ client: clientOverPlanServer(server) });
  store.dispatch(listSessionPlanApi.endpoints.listSessionPlan.initiate(sessionId));
  await new Promise((r) => setTimeout(r, 0));

  const added = await store.dispatch(
    addSessionPlanTodoApi.endpoints.addSessionPlanTodo.initiate({
      sessionId,
      requestId: 'idem_addfordelete1',
      text: 'Draft'
    })
  );
  await new Promise((r) => setTimeout(r, 0));
  const todoId = ('data' in added ? added.data?.todo.id : undefined) as SessionPlanTodoId;
  expect(planCacheTodos(store)).toHaveLength(1);

  const deleted = await store.dispatch(
    deleteSessionPlanTodoApi.endpoints.deleteSessionPlanTodo.initiate({
      sessionId,
      todoId,
      requestId: 'idem_delplantodo01',
      expectedVersion: 0
    })
  );
  await new Promise((r) => setTimeout(r, 0));

  expect('data' in deleted && deleted.data).toEqual({ deleted: true, todoId });
  expect(planCacheTodos(store)).toEqual([]);
  expect(server.todos.size).toBe(0);
});
