// e2e: proves the public wire (`/v1/sessions/:id/plan/*`) actually routes through the real
// HTTP dispatch/controller into the durable plan store — the unit tests for
// `createSessionPlanHandlers` call the handler functions directly and never exercise
// daemonHttpContract, Elysia route registration, or buildOperationSource at the controller.

import type { Database } from 'bun:sqlite';
import type { ProjectId, ProjectMemberId, SessionId } from '@monad/protocol';

import { afterEach, describe, expect, test } from 'bun:test';

import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, TRANSPORTS, type TransportHandle } from '../helpers.ts';

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});

// P0-C's durable footprint spans five tables; `sessionPlans.get()` only reflects two of them.
// Store-level idempotency and audit assertions below inspect the complete footprint.
const PLAN_TABLES = [
  'session_plans',
  'session_plan_todos',
  'session_plan_mutations',
  'session_plan_events',
  'session_plan_audit_log'
] as const;

function planTableCounts(handlers: ReturnType<typeof buildHandlers>, sessionId: SessionId): Record<string, number> {
  const sqlite = (handlers.store as unknown as { sqlite: Database }).sqlite;
  return Object.fromEntries(
    PLAN_TABLES.map((table) => [
      table,
      (sqlite.query(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(sessionId) as { n: number }).n
    ])
  );
}

const ZERO_PLAN_FOOTPRINT: Record<string, number> = Object.fromEntries(PLAN_TABLES.map((table) => [table, 0]));

async function responseError(res: Response): Promise<{ error?: string; code?: string }> {
  return (await res.json().catch(() => ({}))) as { error?: string; code?: string };
}

async function createSession(t: TransportHandle): Promise<SessionId> {
  const res = await t.fetch('/v1/sessions', json('POST', { title: 'plan public e2e' }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { sessionId: SessionId }).sessionId;
}

// A session bound to a real project + enabled member, so `assigneeProjectMemberId` resolution
// (400 assignee_not_found vs a valid assignee) has something real to check against.
async function createProjectSessionWithMember(
  t: TransportHandle,
  handlers: ReturnType<typeof buildHandlers>
): Promise<{ sessionId: SessionId; memberId: ProjectMemberId }> {
  const projectRes = await t.fetch('/v1/workplace/projects', json('POST', { title: 'plan public e2e project' }));
  expect(projectRes.status).toBe(201);
  const projectId = ((await projectRes.json()) as { projectId: ProjectId }).projectId;
  const sessionRes = await t.fetch(`/v1/projects/${projectId}/sessions`, json('POST', { title: 'plan public e2e' }));
  expect(sessionRes.status).toBe(201);
  const sessionId = ((await sessionRes.json()) as { sessionId: SessionId }).sessionId;
  const at = new Date().toISOString();
  const memberId = 'pmem_planpubmember1' as ProjectMemberId;
  handlers.store.insertProjectMember({
    id: memberId,
    projectId,
    profileId: 'codex',
    type: 'mesh-agent',
    displayName: 'Plan public member',
    customPrompt: null,
    launchOverrides: {},
    workingDirectoryOverride: null,
    lifecycle: 'enabled',
    createdAt: at,
    updatedAt: at
  });
  return { sessionId, memberId };
}

for (const kind of TRANSPORTS) {
  describe(`public session plan REST over ${kind}`, () => {
    let t: TransportHandle;

    afterEach(async () => {
      await t?.stop();
    });

    test('add/list/update/delete round-trip attributes to a human actor with no projectMemberId', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);

      const added = await t.fetch(
        `/v1/sessions/${sessionId}/plan/todos`,
        json('POST', { requestId: 'idem_pubaddtodo01', text: 'Ship the wire' })
      );
      expect(added.status).toBe(200);
      const { todo } = (await added.json()) as { todo: { id: string; version: number; createdBy: unknown } };
      expect(todo).toMatchObject({ sessionId, text: 'Ship the wire', status: 'pending', version: 0 });
      expect(todo.createdBy).toEqual({ source: { surface: 'web', client: 'monad-web', transport: 'http' } });
      expect((todo.createdBy as { projectMemberId?: unknown }).projectMemberId).toBeUndefined();

      const listed = await t.fetch(`/v1/sessions/${sessionId}/plan`);
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({ plan: { sessionId, todos: [todo] } });

      const updated = await t.fetch(
        `/v1/sessions/${sessionId}/plan/todos/${todo.id}`,
        json('PATCH', { requestId: 'idem_pubupdtodo01', expectedVersion: 0, patch: { status: 'in_progress' } })
      );
      expect(updated.status).toBe(200);
      expect(((await updated.json()) as { todo: { status: string; version: number } }).todo).toMatchObject({
        status: 'in_progress',
        version: 1
      });

      const deleted = await t.fetch(
        `/v1/sessions/${sessionId}/plan/todos/${todo.id}`,
        json('DELETE', { requestId: 'idem_pubdeltodo01', expectedVersion: 1 })
      );
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ deleted: true, todoId: todo.id });

      const afterDelete = await t.fetch(`/v1/sessions/${sessionId}/plan`);
      expect(await afterDelete.json()).toEqual({ plan: { sessionId, todos: [] } });
    });

    test('replaying the same requestId with the same payload returns the identical response and does not duplicate the mutation or event', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      const body = { requestId: 'idem_pubreplay001', text: 'Replay me' };

      const first = await t.fetch(`/v1/sessions/${sessionId}/plan/todos`, json('POST', body));
      const replayed = await t.fetch(`/v1/sessions/${sessionId}/plan/todos`, json('POST', body));

      expect(first.status).toBe(200);
      expect(replayed.status).toBe(200);
      expect(await replayed.json()).toEqual(await first.json());
      // Raw footprint: exactly one durable todo, one mutation row, one event row — the replay
      // reads the stored result, it never inserts a second time.
      expect(planTableCounts(handlers, sessionId)).toEqual({
        ...ZERO_PLAN_FOOTPRINT,
        session_plans: 1,
        session_plan_todos: 1,
        session_plan_mutations: 1,
        session_plan_events: 1,
        session_plan_audit_log: 2
      });
      // The audit log is not "not duplicated" in the naive sense — the design records one row
      // per attempt (applied, then replayed), in that exact order.
      const sqlite = (handlers.store as unknown as { sqlite: Database }).sqlite;
      const outcomes = (
        sqlite
          .query('SELECT outcome FROM session_plan_audit_log WHERE session_id = ? ORDER BY rowid')
          .all(sessionId) as Array<{ outcome: string }>
      ).map((row) => row.outcome);
      expect(outcomes).toEqual(['applied', 'replayed']);
    });

    test('reusing a requestId with a different payload is a stable 409 idempotency conflict, not a second write', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      const requestId = 'idem_pubconflict1';

      const first = await t.fetch(`/v1/sessions/${sessionId}/plan/todos`, json('POST', { requestId, text: 'First' }));
      expect(first.status).toBe(200);

      const conflicting = await t.fetch(
        `/v1/sessions/${sessionId}/plan/todos`,
        json('POST', { requestId, text: 'Different text, same requestId' })
      );

      expect(conflicting.status).toBe(409);
      expect(await responseError(conflicting)).toMatchObject({ code: 'CONFLICT' });
      expect(handlers.store.sessionPlans.get(sessionId)?.todos).toHaveLength(1);
      expect(handlers.store.sessionPlans.get(sessionId)?.todos[0]).toMatchObject({ text: 'First' });
    });

    test('two concurrent updates at the same expectedVersion with different requestIds: exactly one succeeds, the other is a stable 409 version conflict', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      const added = await t.fetch(
        `/v1/sessions/${sessionId}/plan/todos`,
        json('POST', { requestId: 'idem_pubcas000001', text: 'Draft' })
      );
      const { todo } = (await added.json()) as { todo: { id: string; version: number } };

      const [a, b] = await Promise.all([
        t.fetch(
          `/v1/sessions/${sessionId}/plan/todos/${todo.id}`,
          json('PATCH', {
            requestId: 'idem_pubcasrace01',
            expectedVersion: todo.version,
            patch: { status: 'in_progress' }
          })
        ),
        t.fetch(
          `/v1/sessions/${sessionId}/plan/todos/${todo.id}`,
          json('PATCH', {
            requestId: 'idem_pubcasrace02',
            expectedVersion: todo.version,
            patch: { status: 'completed' }
          })
        )
      ]);
      const statuses = [a.status, b.status].sort();

      expect(statuses).toEqual([200, 409]);
      const conflictRes = a.status === 409 ? a : b;
      expect(await responseError(conflictRes)).toMatchObject({ code: 'CONFLICT' });
      expect(handlers.store.sessionPlans.get(sessionId)?.todos[0]?.version).toBe(1);
    });

    test('assigning a nonexistent project member is a stable 400 invalid request, not a mutation', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const { sessionId } = await createProjectSessionWithMember(t, handlers);

      const res = await t.fetch(
        `/v1/sessions/${sessionId}/plan/todos`,
        json('POST', {
          requestId: 'idem_pubbadasign1',
          text: 'Assign to nobody',
          assigneeProjectMemberId: 'pmem_doesnotexist1'
        })
      );

      expect(res.status).toBe(400);
      expect(await responseError(res)).toMatchObject({ code: 'VALIDATION' });
      expect(handlers.store.sessionPlans.get(sessionId)).toBeNull();
    });

    test('assigning a real project member succeeds', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const { sessionId, memberId } = await createProjectSessionWithMember(t, handlers);

      const res = await t.fetch(
        `/v1/sessions/${sessionId}/plan/todos`,
        json('POST', {
          requestId: 'idem_pubgdassign1',
          text: 'Assign to real member',
          assigneeProjectMemberId: memberId
        })
      );

      expect(res.status).toBe(200);
      expect(((await res.json()) as { todo: { assigneeProjectMemberId: string } }).todo.assigneeProjectMemberId).toBe(
        memberId
      );
    });

    test('a channel-origin session accepts public HTTP plan mutations', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = 'ses_planpubchn01' as SessionId;
      const at = new Date().toISOString();
      handlers.store.insertSession({
        id: sessionId,
        title: 'channel-owned',
        state: 'active',
        agentIds: [],
        archived: false,
        restoreCount: 0,
        activityAt: at,
        createdAt: at,
        updatedAt: at,
        origin: { surface: 'im', client: 'telegram', transport: 'channel' }
      });

      const res = await t.fetch(
        `/v1/sessions/${sessionId}/plan/todos`,
        json('POST', { requestId: 'idem_pubauthz0001', text: 'Cross-transport task' })
      );

      expect({ body: await res.json(), status: res.status }).toEqual({
        body: expect.objectContaining({
          todo: expect.objectContaining({ sessionId, status: 'pending', text: 'Cross-transport task' })
        }),
        status: 200
      });
    });
  });
}
