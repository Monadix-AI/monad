import type { Session, SessionPlanTodo } from '@monad/protocol';
import type { SessionPlanHumanAttribution } from '#/store/db/session-plans.ts';

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStore } from '#/store/db/index.ts';

const createdAt = '2026-07-27T08:00:00.000Z';
const updatedAt = '2026-07-27T08:05:00.000Z';
const sessionId = 'ses_plan00000001' as const;
const human: SessionPlanHumanAttribution = {
  source: { surface: 'api', client: 'test', transport: 'http' }
};
const humanActor = { kind: 'human' as const, attribution: human };
const todo: SessionPlanTodo = {
  id: 'todo_planrestart1',
  sessionId,
  text: 'Resume after restart',
  status: 'pending',
  version: 0,
  createdBy: human,
  updatedBy: human,
  createdAt,
  updatedAt: createdAt
};
const event = {
  id: 'evt_planrestart1' as const,
  type: 'session.plan.todo_upserted' as const,
  payload: { sessionId, todo },
  at: createdAt
};

function session(): Session {
  return {
    id: sessionId,
    title: sessionId,
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    activityAt: createdAt,
    createdAt,
    updatedAt: createdAt
  };
}

test('plan state, idempotency, and pending event identity survive a database reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'monad-session-plan-'));
  const path = join(directory, 'store.sqlite');
  const firstStore = createStore({ path });
  try {
    firstStore.insertSession(session());
    const firstPlans = firstStore.sessionPlans;
    firstPlans.addTodo({
      sessionId,
      requestId: 'idem_planrestart1',
      todoId: todo.id,
      eventId: event.id,
      text: todo.text,
      actor: humanActor,
      at: createdAt
    });
  } finally {
    firstStore.close();
  }

  const reopenedStore = createStore({ path });
  try {
    const reopenedPlans = reopenedStore.sessionPlans;
    const replay = reopenedPlans.addTodo({
      sessionId,
      requestId: 'idem_planrestart1',
      todoId: 'todo_planignored1',
      eventId: 'evt_planignored1',
      text: todo.text,
      actor: humanActor,
      at: updatedAt
    });
    expect({
      plan: reopenedPlans.get(sessionId),
      replay,
      pending: reopenedPlans.listPendingEvents()
    }).toEqual({
      plan: { sessionId, todos: [todo] },
      replay: {
        ok: true,
        replayed: true,
        response: { todo },
        event
      },
      pending: [event]
    });
  } finally {
    reopenedStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
