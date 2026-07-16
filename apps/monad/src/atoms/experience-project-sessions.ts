import type { ProjectId, SessionId } from '@monad/protocol';
import type { ProjectSessionOperations } from '@monad/sdk-atom';
import type { createSessionModule } from '#/handlers/session/index.ts';
import type { OversightService } from '#/services/oversight.ts';
import type { Store } from '#/store/db/index.ts';

import { createHash } from 'node:crypto';

const MAX_OBSERVATION_TEXT = 512;

function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function observationText(event: { type: string; payload: Record<string, unknown> }): string {
  const tool = payloadString(event.payload, 'tool');
  let text: string;
  switch (event.type) {
    case 'agent.message':
      text = payloadString(event.payload, 'text') ?? 'Agent message';
      break;
    case 'agent.error':
      text = 'Agent run failed';
      break;
    case 'agent.reasoning':
      text = 'Agent reasoning update';
      break;
    case 'tool.called':
      text = tool ? `Tool called: ${tool}` : 'Tool called';
      break;
    case 'tool.result':
      text = tool ? `Tool completed: ${tool}` : 'Tool completed';
      break;
    case 'tool.approval_requested':
      text = tool ? `Approval requested: ${tool}` : 'Tool approval requested';
      break;
    case 'tool.approval_resolved':
      text = tool ? `Approval resolved: ${tool}` : 'Tool approval resolved';
      break;
    case 'session.stream_ended':
      text = 'Session turn ended';
      break;
    default:
      text = event.type;
  }
  return text.slice(0, MAX_OBSERVATION_TEXT);
}

function stableSessionId(projectId: string, idempotencyKey: string): SessionId {
  const digest = createHash('sha256').update(`${projectId}\0${idempotencyKey}`).digest('hex');
  return `ses_${digest.slice(0, 20)}` as SessionId;
}

function assertProject(store: Store, projectId: string) {
  const project = store.getWorkplaceProject(projectId);
  if (!project) throw new Error(`project not found: ${projectId}`);
  return project;
}

function assertProjectSession(store: Store, sessionId: string) {
  const session = store.getSession(sessionId);
  if (!session?.projectId) {
    throw new Error(`project session not found: ${sessionId}`);
  }
  return session;
}

export function createProjectSessionOperations(input: {
  store: Store;
  sessions: ReturnType<typeof createSessionModule>;
  oversight: OversightService;
}): ProjectSessionOperations {
  const { store, sessions, oversight } = input;
  return {
    list: async (projectId) => {
      assertProject(store, projectId);
      return store
        .listSessions({ projectId: projectId as ProjectId })
        .map((session) => ({ id: session.id, title: session.title, state: session.state }));
    },
    create: async (projectId, request) => {
      assertProject(store, projectId);
      const id = stableSessionId(projectId, request.idempotencyKey);
      const existing = store.getSession(id);
      if (existing) {
        if (existing.projectId !== projectId) {
          throw new Error(`idempotency collision for project session: ${id}`);
        }
        return { id };
      }
      const result = await sessions.createProjectSession({
        projectId: projectId as ProjectId,
        title: request.title,
        cwd: request.cwd,
        id
      });
      return { id: result.sessionId };
    },
    sendMessage: async (sessionId, request) => {
      assertProjectSession(store, sessionId);
      const requestId = createHash('sha256').update(request.idempotencyKey).digest('hex').slice(0, 20);
      const key = `experience:message:${requestId}`;
      const existing = store.getMemory(sessionId, key);
      if (existing) {
        const state = (JSON.parse(existing) as { state?: string }).state;
        if (state === 'scheduled' || state === 'completed') return;
      }
      store.setMemory(sessionId, key, JSON.stringify({ state: 'scheduled' }));
      try {
        await sessions.generate({ sessionId: sessionId as SessionId, text: request.text });
        store.setMemory(sessionId, key, JSON.stringify({ state: 'completed' }));
      } catch (error) {
        store.setMemory(sessionId, key, JSON.stringify({ state: 'failed' }));
        throw error;
      }
    },
    listMessages: async (sessionId, cursor) => {
      assertProjectSession(store, sessionId);
      const items = store.listMessages(sessionId, { before: cursor, latest: true, limit: 100 });
      const oldest = items[0]?.id;
      const hasOlder = oldest ? store.listMessages(sessionId, { before: oldest, limit: 1 }).length > 0 : false;
      return {
        items: items.map((message) => ({
          id: message.id,
          role: message.role,
          text: message.text,
          createdAt: message.createdAt
        })),
        nextCursor: hasOlder ? (oldest ?? null) : null
      };
    },
    listObservations: async (sessionId, cursor) => {
      assertProjectSession(store, sessionId);
      const events = store.listEvents(sessionId, cursor).slice(0, 100);
      return {
        items: events.map((event) => ({
          id: event.id,
          kind: event.type,
          text: observationText(event),
          createdAt: event.at
        })),
        nextCursor: events.length === 100 ? (events.at(-1)?.id ?? null) : null
      };
    },
    runTurn: async (sessionId, request) => {
      assertProjectSession(store, sessionId);
      const runId = createHash('sha256').update(`${sessionId}\0${request.idempotencyKey}`).digest('hex').slice(0, 20);
      const key = `experience:run:${runId}`;
      if (!store.getMemory(sessionId, key)) {
        store.setMemory(sessionId, key, JSON.stringify({ runId, state: 'scheduled' }));
        const timer = setTimeout(() => {
          void sessions
            .generate({ sessionId: sessionId as SessionId, text: request.text })
            .then(() => store.setMemory(sessionId, key, JSON.stringify({ runId, state: 'completed' })))
            .catch((error) =>
              store.setMemory(
                sessionId,
                key,
                JSON.stringify({
                  runId,
                  state: 'failed',
                  error: error instanceof Error ? error.message : String(error)
                })
              )
            );
        }, 0);
        timer.unref();
      }
      return { runId };
    },
    pause: async (sessionId) => {
      assertProjectSession(store, sessionId);
      await sessions.abort({ id: sessionId as SessionId });
    },
    cancel: async (sessionId) => {
      assertProjectSession(store, sessionId);
      await sessions.update({ id: sessionId as SessionId, state: 'cancelled' });
    },
    listPendingApprovals: async (projectId, sessionId) => {
      assertProject(store, projectId);
      if (sessionId) {
        const session = assertProjectSession(store, sessionId);
        if (session.projectId !== projectId) throw new Error(`session does not belong to project: ${sessionId}`);
      }
      const projectSessionIds = new Set(
        store.listSessions({ projectId: projectId as ProjectId }).map((session) => session.id)
      );
      return oversight
        .listPendingRequests(sessionId)
        .filter((approval) => projectSessionIds.has(approval.sessionId as SessionId));
    },
    resolveApproval: async (approvalId, decision) => {
      const pending = oversight.listPendingRequests().find((approval) => approval.id === approvalId);
      if (!pending) throw new Error(`approval not found: ${approvalId}`);
      assertProjectSession(store, pending.sessionId);
      const resolved = await oversight.respond(approvalId, decision === 'approved');
      if (!resolved) throw new Error(`approval already resolved: ${approvalId}`);
    }
  };
}
