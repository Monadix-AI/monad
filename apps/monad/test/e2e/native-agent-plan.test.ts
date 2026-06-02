import type { Database } from 'bun:sqlite';
import type { MeshSessionId, ProjectId, SessionId } from '@monad/protocol';

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, TRANSPORTS, type TransportHandle } from '../helpers.ts';

// P0-C's durable SessionPlan footprint spans five tables. `sessionPlans.get()` only reflects
// `session_plans`/`session_plan_todos` — a "zero writes" claim on a fail-closed path must prove
// all five are untouched, since `session_plan_mutations`/`session_plan_audit_log` are written
// even by a *rejected* store-level mutation (idempotent replay + audit trail by design). The
// managed fail-closed paths here never reach store code at all (requireManagedBinding throws
// first), so the true expectation is zero rows in every one of these tables, not just an empty
// projected plan.
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

const AGENT_TOKEN = 'managed-agent-plan-token';

const tokenHash = (token = AGENT_TOKEN): string => createHash('sha256').update(token).digest('hex');

const json = (body: unknown, headers?: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

async function responseError(res: Response): Promise<{ error?: string; code?: string }> {
  return (await res.json().catch(() => ({}))) as { error?: string; code?: string };
}

async function createProject(t: TransportHandle): Promise<ProjectId> {
  const res = await t.fetch('/v1/workplace/projects', json({ title: 'Workplace: managed plan' }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { projectId: ProjectId }).projectId;
}

async function createSession(t: TransportHandle): Promise<SessionId> {
  const projectId = await createProject(t);
  const res = await t.fetch(`/v1/projects/${projectId}/sessions`, json({ title: 'Workplace: managed plan' }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { sessionId: SessionId }).sessionId;
}

function bindingHeaders(meshSessionId = 'mesh_plantest0001'): Record<string, string> {
  return {
    authorization: `Bearer ${AGENT_TOKEN}`,
    'x-monad-mesh-session-id': meshSessionId
  };
}

// Establishes a managed runtime bound to the session, mirroring the real spawn path: a
// ProjectMember, an active SessionBinding, and that binding's current-runtime pointer.
function createManagedNativeSession(
  handlers: ReturnType<typeof buildHandlers>,
  sessionId: SessionId,
  id = 'mesh_plantest0001',
  agentName = 'codex',
  state: 'running' | 'stopped' = 'running'
): string {
  handlers.store.upsertMeshSession({
    id,
    transcriptTargetId: sessionId,
    agentName,
    provider: 'codex',
    workingPath: '/tmp/project',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: id,
    agentRuntimeTokenHash: tokenHash(),
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    state,
    pid: state === 'running' ? 123 : null,
    providerSessionRef: null,
    outputSnapshot: '',
    exitCode: null,
    startedAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
    exitedAt: state === 'running' ? null : '2026-06-30T00:00:01.000Z'
  });
  const projectId = handlers.store.getSession(sessionId)?.projectId;
  if (!projectId) throw new Error(`session has no project: ${sessionId}`);
  const memberId = `pmem_${agentName}`;
  const at = '2026-06-30T00:00:00.000Z';
  if (!handlers.store.getProjectMember(projectId, memberId)) {
    handlers.store.insertProjectMember({
      id: memberId,
      projectId,
      profileId: agentName,
      type: 'mesh-agent',
      displayName: agentName,
      customPrompt: null,
      launchOverrides: {},
      workingDirectoryOverride: null,
      lifecycle: 'enabled',
      createdAt: at,
      updatedAt: at
    });
  }
  if (!handlers.store.getSessionBinding(sessionId, memberId)) {
    handlers.store.insertSessionBinding({
      sessionId,
      projectMemberId: memberId,
      lastDeliveredSeq: 0,
      lastVisibleSeq: 0,
      lifecycle: 'active',
      createdAt: at,
      updatedAt: at
    });
  }
  handlers.store.replaceSessionBindingRuntime({
    sessionId,
    projectMemberId: memberId,
    currentNativeRuntimeSessionId: id as MeshSessionId,
    updatedAt: at
  });
  return memberId;
}

for (const kind of TRANSPORTS) {
  describe(`native agent plan proxy over ${kind}`, () => {
    let t: TransportHandle;

    afterEach(async () => {
      await t?.stop();
    });

    test('managed add/list/update/delete round-trip and attribute to the bound project member, never a body-supplied identity', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      const memberId = createManagedNativeSession(handlers, sessionId);

      const added = await t.fetch(
        '/v1/internal/native-agent/project/plan/todos',
        json({ requestId: 'idem_plane2eadd01', text: 'Ship the wire' }, bindingHeaders())
      );
      expect(added.status).toBe(200);
      const { todo } = (await added.json()) as { todo: { id: string; version: number } };
      expect(todo).toMatchObject({ sessionId, text: 'Ship the wire', status: 'pending', version: 0 });
      // Audit: managed mutation is attributed to automation/managed-agent/http with instanceId
      // equal to the caller's meshSessionId, and the bound project member — never anything a
      // forged body field could have supplied (the body schema has no sessionId/actor field to
      // forge in the first place; see the "forged identity fields" test below).
      expect((todo as { createdBy?: unknown }).createdBy).toEqual({
        source: { surface: 'automation', client: 'managed-agent', transport: 'http', instanceId: 'mesh_plantest0001' },
        projectMemberId: memberId
      });

      const listed = await t.fetch('/v1/internal/native-agent/project/plan', { headers: bindingHeaders() });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({ plan: { sessionId, todos: [todo] } });

      const updated = await t.fetch(
        '/v1/internal/native-agent/project/plan/todos/update',
        json(
          { todoId: todo.id, requestId: 'idem_plane2eupd01', expectedVersion: 0, patch: { status: 'in_progress' } },
          bindingHeaders()
        )
      );
      expect(updated.status).toBe(200);
      expect(((await updated.json()) as { todo: { status: string; version: number } }).todo).toMatchObject({
        status: 'in_progress',
        version: 1
      });

      const deleted = await t.fetch(
        '/v1/internal/native-agent/project/plan/todos/delete',
        json({ todoId: todo.id, requestId: 'idem_plane2edel01', expectedVersion: 1 }, bindingHeaders())
      );
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ deleted: true, todoId: todo.id });

      const afterDelete = await t.fetch('/v1/internal/native-agent/project/plan', { headers: bindingHeaders() });
      expect(await afterDelete.json()).toEqual({ plan: { sessionId, todos: [] } });
    });

    test('managed add with an unresolvable assignee is a stable 400 VALIDATION: no todo/plan row, but the mutation+audit rejection record persists', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      const memberId = createManagedNativeSession(handlers, sessionId);

      const res = await t.fetch(
        '/v1/internal/native-agent/project/plan/todos',
        json(
          { requestId: 'idem_plane2ebadas', text: 'Assign to nobody', assigneeProjectMemberId: 'pmem_doesnotexist1' },
          bindingHeaders()
        )
      );

      expect(res.status).toBe(400);
      expect(await responseError(res)).toMatchObject({ code: 'VALIDATION' });
      const counts = planTableCounts(handlers, sessionId);
      expect(counts).toEqual({ ...ZERO_PLAN_FOOTPRINT, session_plan_mutations: 1, session_plan_audit_log: 1 });

      // Same route, real bound member as assignee: succeeds and is attributed correctly.
      const good = await t.fetch(
        '/v1/internal/native-agent/project/plan/todos',
        json(
          { requestId: 'idem_plane2egdas1', text: 'Assign to the bound member', assigneeProjectMemberId: memberId },
          bindingHeaders()
        )
      );
      expect(good.status).toBe(200);
      expect(((await good.json()) as { todo: { assigneeProjectMemberId: string } }).todo.assigneeProjectMemberId).toBe(
        memberId
      );
    });

    test('a forged sessionId/actor/transport field in the body is rejected at the schema boundary, never reaching the plan store', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      const otherSessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId);

      const res = await t.fetch(
        '/v1/internal/native-agent/project/plan/todos',
        json(
          {
            requestId: 'idem_plane2eforg1',
            text: 'should never land',
            sessionId: otherSessionId,
            actor: { kind: 'human', attribution: { source: { surface: 'web', client: 'x', transport: 'http' } } },
            projectMemberId: 'pmem_forged'
          },
          bindingHeaders()
        )
      );

      expect(res.status).toBe(400);
      expect(await responseError(res)).toMatchObject({ code: 'VALIDATION' });
      expect(planTableCounts(handlers, sessionId)).toEqual(ZERO_PLAN_FOOTPRINT);
      expect(planTableCounts(handlers, otherSessionId)).toEqual(ZERO_PLAN_FOOTPRINT);
    });

    test('plan mutations fail closed with zero plan writes outside a managed project runtime', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);

      const res = await t.fetch(
        '/v1/internal/native-agent/project/plan/todos',
        json({ requestId: 'idem_plane2eunbd1', text: 'should fail' })
      );

      expect(res.status).toBe(403);
      expect(await responseError(res)).toMatchObject({ code: 'NOT_MANAGED_MESH_AGENT' });
      expect(planTableCounts(handlers, sessionId)).toEqual(ZERO_PLAN_FOOTPRINT);
    });

    test('plan mutations fail closed with an invalid managed agent token, zero plan writes', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId);

      const res = await t.fetch(
        '/v1/internal/native-agent/project/plan/todos',
        json(
          { requestId: 'idem_plane2ebtok1', text: 'should fail' },
          { ...bindingHeaders(), authorization: 'Bearer wrong-token' }
        )
      );

      expect(res.status).toBe(403);
      expect(await responseError(res)).toMatchObject({ code: 'INVALID_NATIVE_AGENT_TOKEN' });
      expect(planTableCounts(handlers, sessionId)).toEqual(ZERO_PLAN_FOOTPRINT);
    });

    test('plan mutations fail closed for a stopped managed runtime even with its old token, zero plan writes', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId, 'mesh_planstopped1', 'codex', 'stopped');

      const res = await t.fetch(
        '/v1/internal/native-agent/project/plan/todos',
        json({ requestId: 'idem_plane2estop1', text: 'should fail' }, bindingHeaders('mesh_planstopped1'))
      );

      expect(res.status).toBe(403);
      expect(await responseError(res)).toMatchObject({ code: 'MESH_SESSION_NOT_ACTIVE' });
      expect(planTableCounts(handlers, sessionId)).toEqual(ZERO_PLAN_FOOTPRINT);
    });

    test('a superseded managed runtime is fenced out of plan mutations even with a still-valid token, zero plan writes', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId, 'mesh_planoldrun01', 'codex');
      createManagedNativeSession(handlers, sessionId, 'mesh_plannewrun01', 'codex');

      const stale = await t.fetch(
        '/v1/internal/native-agent/project/plan/todos',
        json({ requestId: 'idem_plane2estal1', text: 'stale write' }, bindingHeaders('mesh_planoldrun01'))
      );
      expect(stale.status).toBe(403);
      expect(await responseError(stale)).toMatchObject({ code: 'MESH_SESSION_NOT_CURRENT' });
      expect(planTableCounts(handlers, sessionId)).toEqual(ZERO_PLAN_FOOTPRINT);

      const current = await t.fetch(
        '/v1/internal/native-agent/project/plan/todos',
        json({ requestId: 'idem_plane2ecurr1', text: 'current write' }, bindingHeaders('mesh_plannewrun01'))
      );
      expect(current.status).toBe(200);
      expect(handlers.store.sessionPlans.get(sessionId)?.todos).toHaveLength(1);
    });

    test('a left session binding fences plan mutations even with the last-current token, zero additional plan writes', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId, 'mesh_planleaver01', 'codex');
      handlers.store.leaveSessionBinding(sessionId, 'pmem_codex', new Date().toISOString());

      const res = await t.fetch(
        '/v1/internal/native-agent/project/plan/todos',
        json({ requestId: 'idem_plane2eleft1', text: 'should fail' }, bindingHeaders('mesh_planleaver01'))
      );

      expect(res.status).toBe(403);
      expect(await responseError(res)).toMatchObject({ code: 'MESH_SESSION_NOT_CURRENT' });
      expect(planTableCounts(handlers, sessionId)).toEqual(ZERO_PLAN_FOOTPRINT);
    });
  });
}
