import type { EventId, Session, SessionPlanTodo, SessionPlanTodoId } from '@monad/protocol';
import type { SessionPlanHumanAttribution } from '#/store/db/session-plans.ts';

import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createStore } from '#/store/db/index.ts';

const createdAt = '2026-07-27T08:00:00.000Z';
const updatedAt = '2026-07-27T08:05:00.000Z';
const sessionId = 'ses_plan00000001' as const;
const otherSessionId = 'ses_plan00000002' as const;

const human: SessionPlanHumanAttribution = {
  source: { surface: 'api', client: 'test', transport: 'http' }
};
const humanActor = { kind: 'human' as const, attribution: human };

function session(id: Session['id'], ownerProjectId?: Session['projectId']): Session {
  return {
    id,
    projectId: ownerProjectId,
    title: id,
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    activityAt: createdAt,
    createdAt,
    updatedAt: createdAt
  };
}

let rootStore: ReturnType<typeof createStore>;
let plans: ReturnType<typeof createStore>['sessionPlans'];

beforeEach(() => {
  rootStore = createStore();
  rootStore.insertSession(session(sessionId));
  rootStore.insertSession(session(otherSessionId));
  plans = rootStore.sessionPlans;
});

afterEach(() => rootStore.close());

test('listing an unused session returns no durable plan row', () => {
  expect(plans.get(sessionId)).toBeNull();
  expect(plans.listTodos(sessionId)).toEqual([]);
  expect(plans.listAudit(sessionId)).toEqual([]);
});

test('deleting a session removes its plan graph and permits clean idempotency-key reuse', () => {
  const requestId = 'idem_plandelete001';
  const first = plans.addTodo({
    sessionId,
    requestId,
    todoId: 'todo_plandel00001',
    eventId: 'evt_plandel00001',
    text: 'Remove this session',
    actor: humanActor,
    at: createdAt
  });

  expect(rootStore.deleteSession(sessionId)).toBe(true);
  expect({
    deletedPlan: plans.get(sessionId),
    deletedTodos: plans.listTodos(sessionId),
    deletedAudit: plans.listAudit(sessionId),
    pendingEvents: plans.listPendingEvents().map((event) => event.id)
  }).toEqual({
    deletedPlan: null,
    deletedTodos: [],
    deletedAudit: [],
    pendingEvents: []
  });

  rootStore.insertSession(session(sessionId));
  const recreated = plans.addTodo({
    sessionId,
    requestId,
    todoId: 'todo_plandel00002',
    eventId: 'evt_plandel00002',
    text: 'Fresh command after recreation',
    actor: humanActor,
    at: updatedAt
  });

  expect({ first, recreated, plan: plans.get(sessionId) }).toEqual({
    first: {
      ok: true,
      replayed: false,
      response: {
        todo: {
          id: 'todo_plandel00001',
          sessionId,
          text: 'Remove this session',
          status: 'pending',
          version: 0,
          createdBy: human,
          updatedBy: human,
          createdAt,
          updatedAt: createdAt
        }
      },
      event: {
        id: 'evt_plandel00001',
        type: 'session.plan.todo_upserted',
        payload: {
          sessionId,
          todo: {
            id: 'todo_plandel00001',
            sessionId,
            text: 'Remove this session',
            status: 'pending',
            version: 0,
            createdBy: human,
            updatedBy: human,
            createdAt,
            updatedAt: createdAt
          }
        },
        at: createdAt
      }
    },
    recreated: {
      ok: true,
      replayed: false,
      response: {
        todo: {
          id: 'todo_plandel00002',
          sessionId,
          text: 'Fresh command after recreation',
          status: 'pending',
          version: 0,
          createdBy: human,
          updatedBy: human,
          createdAt: updatedAt,
          updatedAt
        }
      },
      event: {
        id: 'evt_plandel00002',
        type: 'session.plan.todo_upserted',
        payload: {
          sessionId,
          todo: {
            id: 'todo_plandel00002',
            sessionId,
            text: 'Fresh command after recreation',
            status: 'pending',
            version: 0,
            createdBy: human,
            updatedBy: human,
            createdAt: updatedAt,
            updatedAt
          }
        },
        at: updatedAt
      }
    },
    plan: {
      sessionId,
      todos: [
        {
          id: 'todo_plandel00002',
          sessionId,
          text: 'Fresh command after recreation',
          status: 'pending',
          version: 0,
          createdBy: human,
          updatedBy: human,
          createdAt: updatedAt,
          updatedAt
        }
      ]
    }
  });
});

test('add replays across regenerated server ids and transport source but conflicts on command changes', () => {
  const input = {
    sessionId,
    requestId: 'idem_planadd00001' as const,
    todoId: 'todo_planadd00001' as const,
    eventId: 'evt_planadd00001' as const,
    text: 'Review the migration',
    status: 'pending' as const,
    actor: humanActor,
    at: createdAt
  };

  const applied = plans.addTodo(input);
  plans.markEventPublished('evt_planadd00001', updatedAt);
  const replayed = plans.addTodo({
    ...input,
    todoId: 'todo_ignored00001',
    actor: {
      kind: 'human',
      attribution: { source: { surface: 'api', client: 'retry-client', transport: 'acp' } }
    },
    at: updatedAt
  });
  const conflict = plans.addTodo({ ...input, text: 'Different command', at: updatedAt });

  expect({ applied, replayed, conflict, plan: plans.get(sessionId) }).toEqual({
    applied: {
      ok: true,
      replayed: false,
      response: {
        todo: {
          id: 'todo_planadd00001',
          sessionId,
          text: 'Review the migration',
          status: 'pending',
          version: 0,
          createdBy: human,
          updatedBy: human,
          createdAt,
          updatedAt: createdAt
        }
      },
      event: {
        id: 'evt_planadd00001',
        type: 'session.plan.todo_upserted',
        payload: {
          sessionId,
          todo: {
            id: 'todo_planadd00001',
            sessionId,
            text: 'Review the migration',
            status: 'pending',
            version: 0,
            createdBy: human,
            updatedBy: human,
            createdAt,
            updatedAt: createdAt
          }
        },
        at: createdAt
      }
    },
    replayed: {
      ok: true,
      replayed: true,
      response: {
        todo: {
          id: 'todo_planadd00001',
          sessionId,
          text: 'Review the migration',
          status: 'pending',
          version: 0,
          createdBy: human,
          updatedBy: human,
          createdAt,
          updatedAt: createdAt
        }
      },
      event: null
    },
    conflict: { ok: false, replayed: false, code: 'idempotency_conflict' },
    plan: {
      sessionId,
      todos: [
        {
          id: 'todo_planadd00001',
          sessionId,
          text: 'Review the migration',
          status: 'pending',
          version: 0,
          createdBy: human,
          updatedBy: human,
          createdAt,
          updatedAt: createdAt
        }
      ]
    }
  });
  expect(plans.listAudit(sessionId).map(({ id: _id, ...record }) => record)).toEqual([
    {
      sessionId,
      requestId: 'idem_planadd00001',
      operation: 'add',
      todoId: 'todo_planadd00001',
      source: human.source,
      projectMemberId: null,
      resourceVersion: 0,
      outcome: 'applied',
      errorCode: null,
      createdAt
    },
    {
      sessionId,
      requestId: 'idem_planadd00001',
      operation: 'add',
      todoId: 'todo_planadd00001',
      source: { surface: 'api', client: 'retry-client', transport: 'acp' },
      projectMemberId: null,
      resourceVersion: 0,
      outcome: 'replayed',
      errorCode: null,
      createdAt: updatedAt
    },
    {
      sessionId,
      requestId: 'idem_planadd00001',
      operation: 'add',
      todoId: 'todo_planadd00001',
      source: human.source,
      projectMemberId: null,
      resourceVersion: null,
      outcome: 'rejected',
      errorCode: 'idempotency_conflict',
      createdAt: updatedAt
    }
  ]);
});

test('different todos use independent CAS versions and rejected mutations replay without later applying', () => {
  plans.addTodo({
    sessionId,
    requestId: 'idem_planadd00001',
    todoId: 'todo_planitem0001',
    eventId: 'evt_planitem0001',
    text: 'First',
    status: 'pending',
    actor: humanActor,
    at: createdAt
  });
  plans.addTodo({
    sessionId,
    requestId: 'idem_planadd00002',
    todoId: 'todo_planitem0002',
    eventId: 'evt_planitem0002',
    text: 'Second',
    status: 'pending',
    actor: humanActor,
    at: createdAt
  });

  const first = plans.updateTodo({
    sessionId,
    todoId: 'todo_planitem0001',
    requestId: 'idem_planupdt0001',
    eventId: 'evt_planupdt0001',
    expectedVersion: 0,
    patch: { status: 'in_progress' },
    actor: humanActor,
    at: updatedAt
  });
  const second = plans.updateTodo({
    sessionId,
    todoId: 'todo_planitem0002',
    requestId: 'idem_planupdt0002',
    eventId: 'evt_planupdt0002',
    expectedVersion: 0,
    patch: { text: 'Second revised' },
    actor: humanActor,
    at: updatedAt
  });
  const stale = plans.updateTodo({
    sessionId,
    todoId: 'todo_planitem0001',
    requestId: 'idem_planstale001',
    eventId: 'evt_planstale001',
    expectedVersion: 0,
    patch: { status: 'completed' },
    actor: humanActor,
    at: updatedAt
  });
  const staleReplay = plans.updateTodo({
    sessionId,
    todoId: 'todo_planitem0001',
    requestId: 'idem_planstale001',
    eventId: 'evt_planstale002',
    expectedVersion: 0,
    patch: { status: 'completed' },
    actor: humanActor,
    at: '2026-07-27T08:10:00.000Z'
  });
  const firstTodo: SessionPlanTodo = {
    id: 'todo_planitem0001',
    sessionId,
    text: 'First',
    status: 'in_progress',
    version: 1,
    createdBy: human,
    updatedBy: human,
    createdAt,
    updatedAt
  };
  const secondTodo: SessionPlanTodo = {
    id: 'todo_planitem0002',
    sessionId,
    text: 'Second revised',
    status: 'pending',
    version: 1,
    createdBy: human,
    updatedBy: human,
    createdAt,
    updatedAt
  };

  expect({
    first,
    second,
    stale,
    staleReplay,
    todos: plans.listTodos(sessionId).map(({ id, text, status, version }) => ({ id, text, status, version }))
  }).toEqual({
    first: {
      ok: true,
      replayed: false,
      response: { todo: firstTodo },
      event: {
        id: 'evt_planupdt0001',
        type: 'session.plan.todo_upserted',
        payload: { sessionId, todo: firstTodo },
        at: updatedAt
      }
    },
    second: {
      ok: true,
      replayed: false,
      response: { todo: secondTodo },
      event: {
        id: 'evt_planupdt0002',
        type: 'session.plan.todo_upserted',
        payload: { sessionId, todo: secondTodo },
        at: updatedAt
      }
    },
    stale: { ok: false, replayed: false, code: 'version_conflict', currentVersion: 1 },
    staleReplay: { ok: false, replayed: true, code: 'version_conflict', currentVersion: 1 },
    todos: [
      { id: 'todo_planitem0001', text: 'First', status: 'in_progress', version: 1 },
      { id: 'todo_planitem0002', text: 'Second revised', status: 'pending', version: 1 }
    ]
  });
});

test('delete replays its original success after the todo row is gone', () => {
  plans.addTodo({
    sessionId,
    requestId: 'idem_planadd00001',
    todoId: 'todo_plandelete01',
    eventId: 'evt_plandelete01',
    text: 'Delete me',
    status: 'pending',
    actor: humanActor,
    at: createdAt
  });
  const input = {
    sessionId,
    todoId: 'todo_plandelete01' as const,
    requestId: 'idem_plandelete01' as const,
    eventId: 'evt_plandelete02' as const,
    expectedVersion: 0,
    actor: humanActor,
    at: updatedAt
  };
  const deleted = plans.deleteTodo(input);
  plans.markEventPublished('evt_plandelete02', updatedAt);
  const replayed = plans.deleteTodo({ ...input, eventId: 'evt_plandelete03' });

  expect([deleted, replayed, plans.listTodos(sessionId)]).toEqual([
    {
      ok: true,
      replayed: false,
      response: { deleted: true, todoId: 'todo_plandelete01' },
      event: {
        id: 'evt_plandelete02',
        type: 'session.plan.todo_removed',
        payload: { sessionId, todoId: 'todo_plandelete01', version: 1 },
        at: updatedAt
      }
    },
    {
      ok: true,
      replayed: true,
      response: { deleted: true, todoId: 'todo_plandelete01' },
      event: null
    },
    []
  ]);
});

test('pending event recovery is ordered and bounded', () => {
  for (let index = 0; index < 101; index += 1) {
    const suffix = String(index).padStart(7, '0');
    plans.addTodo({
      sessionId,
      requestId: `idem_batch${suffix}`,
      todoId: `todo_batch${suffix}` as SessionPlanTodoId,
      eventId: `evt_batch${suffix}` as EventId,
      text: `Batch item ${index}`,
      status: 'pending',
      actor: humanActor,
      at: createdAt
    });
  }

  expect({
    firstTwo: plans.listPendingEvents(2).map((event) => event.id),
    defaultPage: plans.listPendingEvents().map((event) => event.id),
    cappedPage: plans.listPendingEvents(Number.MAX_SAFE_INTEGER).map((event) => event.id)
  }).toEqual({
    firstTwo: ['evt_batch0000000', 'evt_batch0000001'],
    defaultPage: Array.from({ length: 100 }, (_, index) => `evt_batch${String(index).padStart(7, '0')}` as EventId),
    cappedPage: Array.from({ length: 101 }, (_, index) => `evt_batch${String(index).padStart(7, '0')}` as EventId)
  });
});
