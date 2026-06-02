import type {
  EventId,
  OperationSource,
  ProjectMember,
  Session,
  SessionBinding,
  SessionPlanTodoId,
  WorkplaceProject
} from '@monad/protocol';
import type { SessionPlanActor } from '#/store/db/session-plan-mutations.ts';

import { expect, test } from 'bun:test';

import { HandlerError } from '#/handlers/handler-error.ts';
import { createSessionContext } from '#/handlers/session/context.ts';
import {
  addPlanTodoCore,
  createSessionPlanHandlers,
  drainPendingSessionPlanEvents
} from '#/handlers/session/handlers/session-plan.ts';
import { EventBus } from '#/services/event-bus.ts';
import { RoundCache } from '#/services/round-cache.ts';
import { createStore } from '#/store/db/index.ts';

const at = '2026-07-27T08:00:00.000Z';
const sessionId = 'ses_planh0000001' as const;
const projectId = 'prj_planh0000001' as const;
const memberId = 'pmem_planh_author';

const humanActor: SessionPlanActor = {
  kind: 'human',
  attribution: { source: { surface: 'api', client: 'test', transport: 'http' } }
};

// The transport layer (HTTP controller / RPC dispatch) always builds this before calling the
// human-facing handlers — see `buildOperationSource` at the sessions controller and `nativeOrigin`
// in methods.ts. Tests stand in for that transport-layer construction directly.
const httpOrigin: OperationSource = { surface: 'web', client: 'monad-web', transport: 'http' };

function fixtureSession(id: Session['id'], ownerProjectId?: Session['projectId']): Session {
  return {
    id,
    projectId: ownerProjectId,
    title: id,
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    activityAt: at,
    createdAt: at,
    updatedAt: at
  };
}

function fixtureProject(id: WorkplaceProject['id']): WorkplaceProject {
  return { id, title: id, state: 'active', archived: false, memberTemplates: [], createdAt: at, updatedAt: at };
}

function fixtureMember(id: string): ProjectMember {
  return {
    id,
    projectId,
    profileId: 'codex',
    type: 'mesh-agent',
    displayName: id,
    customPrompt: null,
    launchOverrides: {},
    workingDirectoryOverride: null,
    lifecycle: 'enabled',
    createdAt: at,
    updatedAt: at
  };
}

function fixtureBinding(): SessionBinding {
  return {
    sessionId,
    projectMemberId: memberId,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    currentNativeRuntimeSessionId: null,
    lifecycle: 'active',
    lastHealth: null,
    createdAt: at,
    updatedAt: at
  };
}

/** Bound-project-member fixture: session belongs to a real project with an active binding, so
 *  project_member-actor mutations pass `validateContext`. */
function boundFixture() {
  const store = createStore();
  store.insertWorkplaceProject(fixtureProject(projectId));
  store.insertProjectMember(fixtureMember(memberId));
  store.insertSession(fixtureSession(sessionId, projectId));
  store.insertSessionBinding(fixtureBinding());
  const bus = new EventBus();
  const ctx = createSessionContext({ store, agent: {} as never, bus, cache: new RoundCache() });
  return { store, bus, handlers: createSessionPlanHandlers(ctx) };
}

function unboundFixture() {
  const store = createStore();
  store.insertSession(fixtureSession(sessionId));
  const bus = new EventBus();
  const ctx = createSessionContext({ store, agent: {} as never, bus, cache: new RoundCache() });
  return { store, bus, handlers: createSessionPlanHandlers(ctx) };
}

test('listPlan returns an empty plan without creating a durable row for an untouched session', () => {
  const { store, handlers } = unboundFixture();
  expect(handlers.listPlan({ id: sessionId })).toEqual({ plan: { sessionId, todos: [] } });
  expect(store.sessionPlans.get(sessionId)).toBeNull();
});

test('addPlanTodo publishes exactly one control event, marks the outbox row published, and attributes to a server-derived human actor', () => {
  const { store, bus, handlers } = unboundFixture();
  const received: string[] = [];
  bus.subscribeControl((event) => received.push(event.type));

  const { todo } = handlers.addPlanTodo({
    id: sessionId,
    requestId: 'idem_planh_add01',
    text: 'Ship the handler layer',
    origin: httpOrigin
  });

  expect(todo).toMatchObject({ sessionId, text: 'Ship the handler layer', status: 'pending', version: 0 });
  expect(todo.createdBy).toEqual({ source: { surface: 'web', client: 'monad-web', transport: 'http' } });
  expect(received).toEqual(['session.plan.todo_upserted']);
  expect(store.sessionPlans.listPendingEvents()).toEqual([]);
});

test('addPlanTodo honors an explicit origin hint for surface/client but the wire never accepts an actor or projectMemberId', () => {
  const { handlers } = unboundFixture();
  const { todo } = handlers.addPlanTodo({
    id: sessionId,
    requestId: 'idem_planh_add01b',
    text: 'From the CLI',
    origin: { surface: 'tui', client: 'monad-cli', transport: 'http' }
  });
  expect(todo.createdBy).toEqual({ source: { surface: 'tui', client: 'monad-cli', transport: 'http' } });
  // TS enforces this statically (no `actor`/`projectMemberId` field on the args type); this is the
  // runtime half of that guarantee — attribution never carries a projectMemberId for this path.
  expect(todo.createdBy.projectMemberId).toBeUndefined();
});

test('updatePlanTodo applies the CAS version and republishes exactly once', () => {
  const { bus, handlers } = unboundFixture();
  const received: string[] = [];
  bus.subscribeControl((event) => received.push(event.type));

  const { todo } = handlers.addPlanTodo({
    id: sessionId,
    requestId: 'idem_planh_add02',
    text: 'Draft',
    origin: httpOrigin
  });
  const { todo: updated } = handlers.updatePlanTodo({
    id: sessionId,
    todoId: todo.id,
    requestId: 'idem_planh_upd01',
    expectedVersion: todo.version,
    origin: httpOrigin,
    patch: { status: 'in_progress' }
  });

  expect(updated).toMatchObject({ id: todo.id, status: 'in_progress', version: 1 });
  expect(received).toEqual(['session.plan.todo_upserted', 'session.plan.todo_upserted']);
});

test('updatePlanTodo rejects a stale expectedVersion as a stable conflict, not a mutation', () => {
  const { handlers } = unboundFixture();
  const { todo } = handlers.addPlanTodo({
    id: sessionId,
    requestId: 'idem_planh_add03',
    text: 'Draft',
    origin: httpOrigin
  });

  expect(() =>
    handlers.updatePlanTodo({
      id: sessionId,
      todoId: todo.id,
      requestId: 'idem_planh_upd02',
      expectedVersion: todo.version + 1,
      origin: httpOrigin,
      patch: { status: 'completed' }
    })
  ).toThrow(HandlerError);
  try {
    handlers.updatePlanTodo({
      id: sessionId,
      todoId: todo.id,
      requestId: 'idem_planh_upd03',
      expectedVersion: todo.version + 1,
      origin: httpOrigin,
      patch: { status: 'completed' }
    });
    throw new Error('expected HandlerError');
  } catch (error) {
    expect(error).toBeInstanceOf(HandlerError);
    expect((error as HandlerError).kind).toBe('conflict');
    expect((error as HandlerError).code).toBe('version_conflict');
  }
});

test('deletePlanTodo removes the todo and publishes the removal event exactly once', () => {
  const { bus, handlers } = unboundFixture();
  const received: string[] = [];
  bus.subscribeControl((event) => received.push(event.type));
  const { todo } = handlers.addPlanTodo({
    id: sessionId,
    requestId: 'idem_planh_add04',
    text: 'Draft',
    origin: httpOrigin
  });

  const deleted = handlers.deletePlanTodo({
    id: sessionId,
    todoId: todo.id,
    requestId: 'idem_planh_del01',
    expectedVersion: todo.version,
    origin: httpOrigin
  });

  expect(deleted).toEqual({ deleted: true, todoId: todo.id });
  expect(received).toEqual(['session.plan.todo_upserted', 'session.plan.todo_removed']);
  expect(handlers.listPlan({ id: sessionId })).toEqual({ plan: { sessionId, todos: [] } });
});

test('addPlanTodo replay does not re-publish an already-delivered event', () => {
  const { bus, handlers } = unboundFixture();
  const received: string[] = [];
  bus.subscribeControl((event) => received.push(event.type));

  const first = handlers.addPlanTodo({
    id: sessionId,
    requestId: 'idem_planh_add05',
    text: 'Draft',
    origin: httpOrigin
  });
  const replayed = handlers.addPlanTodo({
    id: sessionId,
    requestId: 'idem_planh_add05',
    text: 'Draft',
    origin: httpOrigin
  });

  expect(replayed.todo).toEqual(first.todo);
  expect(received).toEqual(['session.plan.todo_upserted']);
});

test('plan reads are allowed on an interactive session regardless of origin transport', () => {
  const store = createStore();
  store.insertSession({
    ...fixtureSession(sessionId),
    origin: { surface: 'im', client: 'telegram', transport: 'channel' }
  });
  const bus = new EventBus();
  const ctx = createSessionContext({ store, agent: {} as never, bus, cache: new RoundCache() });
  const handlers = createSessionPlanHandlers(ctx);
  const getSpy = { calls: 0 };
  const originalGet = store.sessionPlans.get.bind(store.sessionPlans);
  store.sessionPlans.get = ((...args: Parameters<typeof originalGet>) => {
    getSpy.calls += 1;
    return originalGet(...args);
  }) as typeof originalGet;

  const result = handlers.listPlan({ id: sessionId });

  expect({ getCalls: getSpy.calls, result }).toEqual({
    getCalls: 1,
    result: { plan: { sessionId, todos: [] } }
  });
});

test('plan mutations are allowed on an interactive session regardless of origin transport', () => {
  const store = createStore();
  store.insertSession({
    ...fixtureSession(sessionId),
    origin: { surface: 'im', client: 'telegram', transport: 'channel' }
  });
  const bus = new EventBus();
  const ctx = createSessionContext({ store, agent: {} as never, bus, cache: new RoundCache() });
  const handlers = createSessionPlanHandlers(ctx);
  const getSpy = { calls: 0 };
  const originalGet = store.sessionPlans.get.bind(store.sessionPlans);
  store.sessionPlans.get = ((...args: Parameters<typeof originalGet>) => {
    getSpy.calls += 1;
    return originalGet(...args);
  }) as typeof originalGet;
  const addSpy = { calls: 0 };
  const originalAdd = store.sessionPlans.addTodo.bind(store.sessionPlans);
  store.sessionPlans.addTodo = ((...args: Parameters<typeof originalAdd>) => {
    addSpy.calls += 1;
    return originalAdd(...args);
  }) as typeof originalAdd;

  const added = handlers.addPlanTodo({
    id: sessionId,
    requestId: 'idem_planh_authz1',
    text: 'Cross-transport task',
    origin: httpOrigin
  });
  const updated = handlers.updatePlanTodo({
    id: sessionId,
    todoId: added.todo.id,
    requestId: 'idem_planh_authz2',
    expectedVersion: added.todo.version,
    origin: httpOrigin,
    patch: { status: 'completed' }
  });
  const deleted = handlers.deletePlanTodo({
    id: sessionId,
    todoId: added.todo.id,
    requestId: 'idem_planh_authz3',
    expectedVersion: updated.todo.version,
    origin: httpOrigin
  });

  expect({
    addCalls: addSpy.calls,
    added: { status: added.todo.status, text: added.todo.text },
    deleted,
    finalPlan: handlers.listPlan({ id: sessionId }).plan,
    updated: { status: updated.todo.status, version: updated.todo.version }
  }).toEqual({
    addCalls: 1,
    added: { status: 'pending', text: 'Cross-transport task' },
    deleted: { deleted: true, todoId: added.todo.id },
    finalPlan: { sessionId, todos: [] },
    updated: { status: 'completed', version: 1 }
  });
});

// ── Managed-agent path goes through the core mutations directly (as the native-agent service
// does), never through `createSessionPlanHandlers` — the human handlers no longer accept an
// `actor` argument at all, by design (see the wire-safety test above).

test('addPlanTodoCore rejects an unbound project-member actor as forbidden, not invalid', () => {
  const { store, bus } = unboundFixture();
  const memberActor: SessionPlanActor = {
    kind: 'project_member',
    attribution: {
      source: { surface: 'automation', client: 'managed-agent', transport: 'http' },
      projectMemberId: memberId
    }
  };

  try {
    addPlanTodoCore(store, bus, sessionId, memberActor, { requestId: 'idem_planh_add06', text: 'Draft' });
    throw new Error('expected HandlerError');
  } catch (error) {
    expect(error).toBeInstanceOf(HandlerError);
    expect((error as HandlerError).kind).toBe('forbidden');
    expect((error as HandlerError).code).toBe('actor_not_bound');
  }
});

test('addPlanTodoCore accepts a bound project-member actor and attributes the todo to it', () => {
  const { store, bus } = boundFixture();
  const memberActor: SessionPlanActor = {
    kind: 'project_member',
    attribution: {
      source: { surface: 'automation', client: 'managed-agent', transport: 'http' },
      projectMemberId: memberId
    }
  };

  const { todo } = addPlanTodoCore(store, bus, sessionId, memberActor, {
    requestId: 'idem_planh_add07',
    text: 'Owned by the bound member',
    assigneeProjectMemberId: memberId
  });

  expect(todo.createdBy).toEqual(memberActor.attribution);
  expect(todo.assigneeProjectMemberId).toBe(memberId);
});

test('drainPendingSessionPlanEvents publishes pending outbox rows in order and clears them', () => {
  const { store, bus } = unboundFixture();
  // Mutate through the store directly (bypassing the handler's own publish) so the durable event
  // lands in the outbox as genuinely unpublished — this is what a crash between `bus.publish` and
  // `markEventPublished`, or a restart with no live subscribers, leaves behind.
  const first = store.sessionPlans.addTodo({
    sessionId,
    requestId: 'idem_planh_drain01',
    todoId: 'todo_plandrain01a',
    eventId: 'evt_plandrain01a',
    text: 'First',
    actor: humanActor,
    at: at
  });
  const second = store.sessionPlans.addTodo({
    sessionId,
    requestId: 'idem_planh_drain02',
    todoId: 'todo_plandrain02a',
    eventId: 'evt_plandrain02a',
    text: 'Second',
    actor: humanActor,
    at: at
  });
  if (!first.ok || !second.ok) throw new Error('fixture mutation failed');
  expect(store.sessionPlans.listPendingEvents().map((event) => event.id)).toEqual([
    'evt_plandrain01a',
    'evt_plandrain02a'
  ]);
  const received: string[] = [];
  bus.subscribeControl((event) => received.push(event.id));

  drainPendingSessionPlanEvents(store, bus);

  expect(received).toEqual(['evt_plandrain01a', 'evt_plandrain02a']);
  expect(store.sessionPlans.listPendingEvents()).toEqual([]);
});

test('drainPendingSessionPlanEvents leaves the failing row and every row after it pending', () => {
  const { store, bus } = unboundFixture();
  const first = store.sessionPlans.addTodo({
    sessionId,
    requestId: 'idem_planh_drain03',
    todoId: 'todo_plandrain03a',
    eventId: 'evt_plandrain03a',
    text: 'Publishes fine',
    actor: humanActor,
    at: at
  });
  const second = store.sessionPlans.addTodo({
    sessionId,
    requestId: 'idem_planh_drain04',
    todoId: 'todo_plandrain04a',
    eventId: 'evt_plandrain04a',
    text: 'Poison',
    actor: humanActor,
    at: at
  });
  const third = store.sessionPlans.addTodo({
    sessionId,
    requestId: 'idem_planh_drain05',
    todoId: 'todo_plandrain05a',
    eventId: 'evt_plandrain05a',
    text: 'Never reached',
    actor: humanActor,
    at: at
  });
  if (!first.ok || !second.ok || !third.ok) throw new Error('fixture mutation failed');
  bus.subscribeControl((event) => {
    if (event.id === 'evt_plandrain04a') throw new Error('poison subscriber');
  });

  expect(() => drainPendingSessionPlanEvents(store, bus)).toThrow('poison subscriber');

  expect(store.sessionPlans.listPendingEvents().map((event) => event.id)).toEqual([
    'evt_plandrain04a',
    'evt_plandrain05a'
  ]);
});

test('drainPendingSessionPlanEvents is a no-op on an empty outbox and does not re-publish', () => {
  const { store, bus, handlers } = unboundFixture();
  const received: string[] = [];
  bus.subscribeControl((event) => received.push(event.id));

  drainPendingSessionPlanEvents(store, bus);
  expect(received).toEqual([]);

  handlers.addPlanTodo({ id: sessionId, requestId: 'idem_planh_drain06', text: 'Live path', origin: httpOrigin });
  expect(received).toHaveLength(1);
  const afterHandlerPublish = [...received];

  drainPendingSessionPlanEvents(store, bus);

  expect(received).toEqual(afterHandlerPublish);
  expect(store.sessionPlans.listPendingEvents()).toEqual([]);
});

function seedBulkPending(store: ReturnType<typeof createStore>, count: number): EventId[] {
  const eventIds: EventId[] = [];
  for (let i = 0; i < count; i++) {
    const suffix = `bulk${String(i).padStart(8, '0')}`;
    const eventId = `evt_${suffix}` as EventId;
    const result = store.sessionPlans.addTodo({
      sessionId,
      requestId: `idem_${suffix}`,
      todoId: `todo_${suffix}` as SessionPlanTodoId,
      eventId,
      text: `Bulk ${i}`,
      actor: humanActor,
      at
    });
    if (!result.ok) throw new Error(`fixture mutation ${i} failed: ${result.code}`);
    eventIds.push(eventId);
  }
  return eventIds;
}

test('drainPendingSessionPlanEvents pages past the batch size until the outbox is fully empty', () => {
  const { store, bus } = unboundFixture();
  const expectedIds = seedBulkPending(store, 101);
  expect(store.sessionPlans.listPendingEvents(101)).toHaveLength(101);
  const received: string[] = [];
  bus.subscribeControl((event) => received.push(event.id));

  drainPendingSessionPlanEvents(store, bus, 25);

  expect(received).toEqual(expectedIds);
  expect(store.sessionPlans.listPendingEvents(200)).toEqual([]);
});

test('drainPendingSessionPlanEvents stops mid-second-batch: first batch stays published, poison and later rows stay pending', () => {
  const { store, bus } = unboundFixture();
  const expectedIds = seedBulkPending(store, 7);
  const batchSize = 3;
  // Row index 4 (0-based) is the second item of the second batch [3,4,5].
  const [poisonId] = expectedIds.slice(4, 5);
  if (!poisonId) throw new Error('fixture must seed at least 5 rows');
  const received: string[] = [];
  bus.subscribeControl((event) => {
    if (event.id === poisonId) throw new Error('poison subscriber');
    received.push(event.id);
  });

  expect(() => drainPendingSessionPlanEvents(store, bus, batchSize)).toThrow('poison subscriber');

  expect(received).toEqual(expectedIds.slice(0, 4));
  expect(store.sessionPlans.listPendingEvents(10).map((event) => event.id)).toEqual(expectedIds.slice(4));
});
