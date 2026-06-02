import type { Database } from 'bun:sqlite';
import type { MeshSessionId, ProjectId, SessionId } from '@monad/protocol';

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { MonadClient } from '@monad/client';

import { createHttpTransport } from '../../../monad/src/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, type TransportHandle } from '../../../monad/test/helpers.ts';
import { createAgentFacingMcpHandler } from '../../src/lib/agent-facing-mcp-server.ts';

// The MCP handler's own unit suite drives fenced routes through a fake client with canned errors, which
// cannot prove the real MCP -> Treaty -> daemon -> requireManagedBinding chain. This exercises the actual
// managed-binding fence: a real client authenticates with the runtime token, the proxy adds only the
// mesh-session-id header, and the daemon derives identity and enforces the fence. One transport is enough —
// the routes' transport parity is covered by apps/monad's native-agent-plan e2e.

const AGENT_TOKEN = 'managed-agent-mcp-token';
const tokenHash = (token = AGENT_TOKEN): string => createHash('sha256').update(token).digest('hex');

const PLAN_TABLES = [
  'session_plans',
  'session_plan_todos',
  'session_plan_mutations',
  'session_plan_events',
  'session_plan_audit_log'
] as const;
const ZERO_PLAN_FOOTPRINT: Record<string, number> = Object.fromEntries(PLAN_TABLES.map((table) => [table, 0]));

function planTableCounts(handlers: ReturnType<typeof buildHandlers>, sessionId: SessionId): Record<string, number> {
  const sqlite = (handlers.store as unknown as { sqlite: Database }).sqlite;
  return Object.fromEntries(
    PLAN_TABLES.map((table) => [
      table,
      (sqlite.query(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(sessionId) as { n: number }).n
    ])
  );
}

const jsonPost = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

async function createSession(t: TransportHandle): Promise<{ projectId: ProjectId; sessionId: SessionId }> {
  const projectRes = await t.fetch('/v1/workplace/projects', jsonPost({ title: 'Workplace: MCP plan fence' }));
  expect(projectRes.status).toBe(201);
  const projectId = ((await projectRes.json()) as { projectId: ProjectId }).projectId;
  const sessionRes = await t.fetch(`/v1/projects/${projectId}/sessions`, jsonPost({ title: 'MCP plan fence' }));
  expect(sessionRes.status).toBe(201);
  return { projectId, sessionId: ((await sessionRes.json()) as { sessionId: SessionId }).sessionId };
}

// Mirror the real spawn path: a ProjectMember, an active SessionBinding, and that binding's current runtime.
function createManagedNativeSession(
  handlers: ReturnType<typeof buildHandlers>,
  sessionId: SessionId,
  id: string,
  state: 'running' | 'stopped' = 'running'
): string {
  const agentName = 'codex';
  const at = '2026-06-30T00:00:00.000Z';
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
    startedAt: at,
    updatedAt: at,
    exitedAt: state === 'running' ? null : '2026-06-30T00:00:01.000Z'
  });
  const projectId = handlers.store.getSession(sessionId)?.projectId;
  if (!projectId) throw new Error(`session has no project: ${sessionId}`);
  const memberId = `pmem_${agentName}`;
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

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError: boolean };

let callId = 0;

async function mcpPlanCall(
  handler: ReturnType<typeof createAgentFacingMcpHandler>,
  meshSessionId: string,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolResult> {
  Bun.env.MONAD_MESH_SESSION_ID = meshSessionId;
  const response = await handler.handle({
    jsonrpc: '2.0',
    id: ++callId,
    method: 'tools/call',
    params: { name, arguments: args }
  });
  if (!response || !('result' in response)) throw new Error('expected tool result');
  return response.result as ToolResult;
}

const dataOf = (result: ToolResult): unknown => JSON.parse(result.content[0]?.text ?? 'null');

describe('agent-facing MCP plan tools drive the real managed-binding fence', () => {
  let t: TransportHandle | undefined;
  const previousMeshEnv = Bun.env.MONAD_MESH_SESSION_ID;

  afterEach(async () => {
    await t?.stop();
    t = undefined;
    if (previousMeshEnv === undefined) delete Bun.env.MONAD_MESH_SESSION_ID;
    else Bun.env.MONAD_MESH_SESSION_ID = previousMeshEnv;
  });

  test('a current managed runtime adds and lists a todo through the real daemon, attributed to the bound member', async () => {
    const handlers = buildHandlers(mockModel());
    t = serveTransport('tcp', createHttpTransport(handlers));
    const { sessionId } = await createSession(t);
    const memberId = createManagedNativeSession(handlers, sessionId, 'mesh_mcpcurrent01');
    const client = new MonadClient({ baseUrl: t.baseUrl ?? '', token: AGENT_TOKEN });
    const handler = createAgentFacingMcpHandler(client);

    const added = await mcpPlanCall(handler, 'mesh_mcpcurrent01', 'project_plan_add', {
      requestId: 'idem_mcpplanadd01',
      text: 'Wire the fence'
    });
    expect(added.isError).toBe(false);
    const { todo } = dataOf(added) as { todo: { id: string; version: number; createdBy: unknown } };
    expect(todo).toMatchObject({ sessionId, text: 'Wire the fence', status: 'pending', version: 0 });
    // Attribution is derived by the daemon from the binding — never anything the MCP layer supplied.
    expect(todo.createdBy).toEqual({
      source: { surface: 'automation', client: 'managed-agent', transport: 'http', instanceId: 'mesh_mcpcurrent01' },
      projectMemberId: memberId
    });

    const listed = await mcpPlanCall(handler, 'mesh_mcpcurrent01', 'project_plan_list');
    expect(listed.isError).toBe(false);
    expect(dataOf(listed)).toEqual({ plan: { sessionId, todos: [todo] } });
  });

  test('a superseded runtime is fenced out of a plan mutation through the MCP path, with zero plan writes', async () => {
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const handlers = buildHandlers(mockModel());
      t = serveTransport('tcp', createHttpTransport(handlers));
      const { sessionId } = await createSession(t);
      createManagedNativeSession(handlers, sessionId, 'mesh_mcpold000001');
      createManagedNativeSession(handlers, sessionId, 'mesh_mcpnew000001');
      const client = new MonadClient({ baseUrl: t.baseUrl ?? '', token: AGENT_TOKEN });
      const handler = createAgentFacingMcpHandler(client);

      const stale = await mcpPlanCall(handler, 'mesh_mcpold000001', 'project_plan_add', {
        requestId: 'idem_mcpstale0001',
        text: 'stale write'
      });
      expect(stale.isError).toBe(true);
      expect(stale.content[0]?.text).toContain('MESH_SESSION_NOT_CURRENT');
      expect(planTableCounts(handlers, sessionId)).toEqual(ZERO_PLAN_FOOTPRINT);

      // The current runtime still writes through the same MCP path, proving the fence is selective.
      const current = await mcpPlanCall(handler, 'mesh_mcpnew000001', 'project_plan_add', {
        requestId: 'idem_mcpcurr00001',
        text: 'current write'
      });
      expect(current.isError).toBe(false);
      expect(handlers.store.sessionPlans.get(sessionId)?.todos).toHaveLength(1);
    } finally {
      stderr.mockRestore();
    }
  });

  test('a left session binding fences a plan mutation through the MCP path, with zero plan writes', async () => {
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const handlers = buildHandlers(mockModel());
      t = serveTransport('tcp', createHttpTransport(handlers));
      const { sessionId } = await createSession(t);
      const memberId = createManagedNativeSession(handlers, sessionId, 'mesh_mcpleaver001');
      handlers.store.leaveSessionBinding(sessionId, memberId, '2026-06-30T00:00:05.000Z');
      const client = new MonadClient({ baseUrl: t.baseUrl ?? '', token: AGENT_TOKEN });
      const handler = createAgentFacingMcpHandler(client);

      const result = await mcpPlanCall(handler, 'mesh_mcpleaver001', 'project_plan_add', {
        requestId: 'idem_mcpleft00001',
        text: 'should be fenced'
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('MESH_SESSION_NOT_CURRENT');
      expect(planTableCounts(handlers, sessionId)).toEqual(ZERO_PLAN_FOOTPRINT);
    } finally {
      stderr.mockRestore();
    }
  });

  test('a cross-project assignee is rejected on the real daemon path and surfaces through the MCP tool', async () => {
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const handlers = buildHandlers(mockModel());
      t = serveTransport('tcp', createHttpTransport(handlers));
      const { sessionId } = await createSession(t);
      createManagedNativeSession(handlers, sessionId, 'mesh_mcpassign001');
      // A real member of a DIFFERENT project — resolvable globally but not project-scoped to this session.
      const other = await createSession(t);
      const foreignMemberId = 'pmem_foreignmemb1';
      handlers.store.insertProjectMember({
        id: foreignMemberId,
        projectId: other.projectId,
        profileId: 'foreign',
        type: 'mesh-agent',
        displayName: 'Foreign',
        customPrompt: null,
        launchOverrides: {},
        workingDirectoryOverride: null,
        lifecycle: 'enabled',
        createdAt: '2026-06-30T00:00:00.000Z',
        updatedAt: '2026-06-30T00:00:00.000Z'
      });
      const client = new MonadClient({ baseUrl: t.baseUrl ?? '', token: AGENT_TOKEN });
      const handler = createAgentFacingMcpHandler(client);

      const result = await mcpPlanCall(handler, 'mesh_mcpassign001', 'project_plan_add', {
        requestId: 'idem_mcpforeign01',
        text: 'assign across projects',
        assigneeProjectMemberId: foreignMemberId
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('VALIDATION');
      // No todo/plan row lands for the rejected assignee (the daemon records only its mutation+audit trail).
      const counts = planTableCounts(handlers, sessionId);
      expect({ session_plans: counts.session_plans, session_plan_todos: counts.session_plan_todos }).toEqual({
        session_plans: 0,
        session_plan_todos: 0
      });
    } finally {
      stderr.mockRestore();
    }
  });
});
