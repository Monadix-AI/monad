// e2e: proves the boot-time outbox drain wired into `application/lifecycle.ts`
// (`reconcileSessionPlanOutboxAtBoot(store, bus)`, called once at boot right after
// `bindSessionGateway`) actually republishes plan events left pending by a crash, across a REAL
// file-backed close→reopen restart, using the SAME production symbol lifecycle.ts calls — not a
// parallel call to the leaf `drainPendingSessionPlanEvents` helper. It also proves, with real
// production-wired handlers (agent/oversight/clarify/delegation/messageIngress, exactly as
// `buildHandlers` constructs them) plus an explicit model-call spy, that the drain never starts
// an agent turn or appends a message — the P0-C contract that these events are
// session-scoped, control-plane-only (event-table.ts).

import type { Database } from 'bun:sqlite';
import type { SessionId } from '@monad/protocol';
import type { ModelRequest, ModelResult, ModelRouter } from '#/agent/index.ts';

import { expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reconcileSessionPlanOutboxAtBoot } from '#/application/session-plan-boot.ts';
import { mockModel } from '#/infra/mock-model.ts';
import { EventBus } from '#/services/event-bus.ts';
import { createStore } from '#/store/db/index.ts';
import { buildHandlers } from '../helpers.ts';

const now = '2026-07-28T00:00:00.000Z';
const sessionId = 'ses_bootdrain001' as SessionId;
const humanActor = {
  kind: 'human' as const,
  attribution: { source: { surface: 'web' as const, client: 'test', transport: 'http' as const } }
};

const PLAN_TABLES = [
  'session_plans',
  'session_plan_todos',
  'session_plan_mutations',
  'session_plan_events',
  'session_plan_audit_log'
] as const;

// Full durable row snapshot (not just counts) so a second boot's no-op claim is `toEqual`-checked
// against every column, including `published_at`/`updated_at`.
function planSnapshot(sqlite: Database, sid: string): Record<string, unknown[]> {
  return Object.fromEntries(
    PLAN_TABLES.map((table) => [
      table,
      sqlite.query(`SELECT * FROM ${table} WHERE session_id = ? ORDER BY rowid`).all(sid)
    ])
  );
}

// Wraps the real mock model so this suite can assert, by call count rather than by absence of a
// subscriber, that the drain never triggers a generation.
function spyModel(): { router: ModelRouter; calls: { stream: number; complete: number } } {
  const inner = mockModel();
  const calls = { stream: 0, complete: 0 };
  return {
    calls,
    router: {
      async *stream(req: ModelRequest) {
        calls.stream++;
        yield* inner.stream(req);
      },
      async complete(req: ModelRequest): Promise<ModelResult> {
        calls.complete++;
        return inner.complete(req);
      }
    }
  };
}

// Architecture audit: proves the production boot sequence actually calls the tested orchestrator,
// in the required order (after bindSessionGateway) — a passing behavior test of the orchestrator
// alone cannot catch someone deleting or reordering the lifecycle.ts call site.
// artifact-ok: enforceable wiring-order audit, not a proxy for runtime behavior already covered below
test('application/lifecycle.ts calls reconcileSessionPlanOutboxAtBoot after bindSessionGateway', () => {
  const source = readFileSync(join(import.meta.dir, '../../src/application/lifecycle.ts'), 'utf8');
  const bindIndex = source.indexOf('bindSessionGateway(handlers.session);');
  const reconcileIndex = source.indexOf('reconcileSessionPlanOutboxAtBoot(store, bus)');
  expect(bindIndex).toBeGreaterThan(-1);
  expect(reconcileIndex).toBeGreaterThan(bindIndex);
});

test('a plan event left pending by a simulated crash is drained exactly once by the real boot orchestrator, starts no agent turn, and a second boot is a byte-equal no-op', () => {
  const dbPath = join(tmpdir(), `monad-plan-boot-drain-${process.hrtime.bigint()}.sqlite`);
  const cleanup = () => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
  };
  try {
    // ── First boot: mutate through the store directly (bypassing the handler's own publish),
    // leaving the durable event pending — exactly what a crash between `bus.publish` and
    // `markEventPublished`, or a restart with the previous process's subscribers gone, leaves
    // behind. Two todos so the drain must publish both, in order.
    const first = createStore({ path: dbPath });
    first.insertSession({
      id: sessionId,
      title: 'boot drain',
      state: 'active',
      agentIds: [],
      archived: false,
      restoreCount: 0,
      activityAt: now,
      createdAt: now,
      updatedAt: now
    });
    const a = first.sessionPlans.addTodo({
      sessionId,
      requestId: 'idem_bootdrainaa1',
      todoId: 'todo_bootdrainaa1',
      eventId: 'evt_bootdrainaa1',
      text: 'First',
      actor: humanActor,
      at: now
    });
    const b = first.sessionPlans.addTodo({
      sessionId,
      requestId: 'idem_bootdrainbb1',
      todoId: 'todo_bootdrainbb1',
      eventId: 'evt_bootdrainbb1',
      text: 'Second',
      actor: humanActor,
      at: now
    });
    if (!a.ok || !b.ok) throw new Error('fixture mutation failed');
    expect(first.sessionPlans.listPendingEvents().map((e) => e.id)).toEqual(['evt_bootdrainaa1', 'evt_bootdrainbb1']);
    first.close();

    // ── Restart: reopen the durable file, build the real production handler graph on top of it
    // (agent/oversight/clarify/delegation/messageIngress — same construction `buildHandlers`
    // gives every other e2e suite in this repo), and call the exact symbol `startDaemon` calls.
    const rebooted = createStore({ path: dbPath });
    const model = spyModel();
    const handlers = buildHandlers(model.router, undefined, { store: rebooted });
    let firstBootSnapshot: Record<string, unknown[]>;
    try {
      const controlEvents: string[] = [];
      const allEvents: Array<{ type: string }> = [];
      handlers.bus.subscribeControl((event) => controlEvents.push(event.id));
      handlers.bus.subscribeAll((event) => allEvents.push({ type: event.type }));

      const result = reconcileSessionPlanOutboxAtBoot(rebooted, handlers.bus);

      expect(result).toEqual({ drained: 2 });
      // Both pending events reach the control plane, in durable sequence order.
      expect(controlEvents).toEqual(['evt_bootdrainaa1', 'evt_bootdrainbb1']);
      // Nothing beyond the two plan events is published — no fan-out/wake side effect rides
      // along with a boot drain (session.plan.* events are control-plane-only by design).
      expect(allEvents).toEqual([{ type: 'session.plan.todo_upserted' }, { type: 'session.plan.todo_upserted' }]);
      // Explicit spy on the real agent's model router: the drain never starts a generation.
      expect(model.calls).toEqual({ stream: 0, complete: 0 });
      // No consumer appended anything to the transcript either.
      expect(rebooted.listMessages(sessionId)).toEqual([]);
      // The outbox is now empty and the durable rows are marked published.
      expect(rebooted.sessionPlans.listPendingEvents()).toEqual([]);
      expect(rebooted.sessionPlans.get(sessionId)?.todos.map((t) => t.text)).toEqual(['First', 'Second']);

      firstBootSnapshot = planSnapshot((rebooted as unknown as { sqlite: Database }).sqlite, sessionId);
      expect(
        Object.fromEntries(Object.entries(firstBootSnapshot).map(([table, rows]) => [table, rows.length]))
      ).toEqual({
        session_plans: 1,
        session_plan_todos: 2,
        session_plan_mutations: 2,
        session_plan_events: 2,
        session_plan_audit_log: 2
      });
    } finally {
      rebooted.close();
    }

    // ── Second boot: the outbox is already empty, so the real orchestrator must report
    // drained=0, publish nothing, and leave every durable row byte-equal to the first boot's
    // snapshot (including published_at/updated_at — a true no-op, not just "same todo text").
    const again = createStore({ path: dbPath });
    try {
      const secondBus = new EventBus();
      const received: string[] = [];
      secondBus.subscribeControl((event) => received.push(event.id));

      const result = reconcileSessionPlanOutboxAtBoot(again, secondBus);

      expect(result).toEqual({ drained: 0 });
      expect(received).toEqual([]);
      expect(planSnapshot((again as unknown as { sqlite: Database }).sqlite, sessionId)).toEqual(firstBootSnapshot);
    } finally {
      again.close();
    }
  } finally {
    cleanup();
  }
});

test('a poison control subscriber aborts the boot drain and leaves the failing row and every later row pending, exactly as the single-event path does', () => {
  const dbPath = join(tmpdir(), `monad-plan-boot-drain-poison-${process.hrtime.bigint()}.sqlite`);
  const cleanup = () => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
  };
  try {
    const first = createStore({ path: dbPath });
    first.insertSession({
      id: sessionId,
      title: 'boot drain poison',
      state: 'active',
      agentIds: [],
      archived: false,
      restoreCount: 0,
      activityAt: now,
      createdAt: now,
      updatedAt: now
    });
    for (const [suffix, text] of [
      ['aa1', 'Publishes fine'],
      ['bb1', 'Poison'],
      ['cc1', 'Never reached']
    ] as const) {
      const result = first.sessionPlans.addTodo({
        sessionId,
        requestId: `idem_bootpoisn${suffix}`,
        todoId: `todo_bootpoisn${suffix}`,
        eventId: `evt_bootpoisn${suffix}`,
        text,
        actor: humanActor,
        at: now
      });
      if (!result.ok) throw new Error('fixture mutation failed');
    }
    first.close();

    const rebooted = createStore({ path: dbPath });
    try {
      const bus = new EventBus();
      const received: string[] = [];
      bus.subscribeControl((event) => {
        if (event.id === 'evt_bootpoisnbb1') throw new Error('poison subscriber');
        received.push(event.id);
      });

      expect(() => reconcileSessionPlanOutboxAtBoot(rebooted, bus)).toThrow('poison subscriber');

      expect(received).toEqual(['evt_bootpoisnaa1']);
      expect(rebooted.sessionPlans.listPendingEvents().map((e) => e.id)).toEqual([
        'evt_bootpoisnbb1',
        'evt_bootpoisncc1'
      ]);
    } finally {
      rebooted.close();
    }
  } finally {
    cleanup();
  }
});
