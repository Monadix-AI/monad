import type {
  AgentId,
  BranchSessionRequest,
  ListUiItemsResponse,
  MessageId,
  ProjectId,
  RestoreSessionRequest,
  RestoreSessionResponse,
  Session,
  SessionId,
  SessionOrigin,
  SessionState,
  SessionTransport,
  UpdateSessionRequest
} from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';

import { createLogger } from '@monad/logger';
import { newId } from '@monad/protocol';

import { parseDurableSummary } from '#/agent/history.ts';
import { canTransition } from '#/agent/index.ts';
import { clearProcessesForSession, disposeSandboxSession, processControlTool } from '#/capabilities/tools';
import { HandlerError } from '#/handlers/handler-error.ts';
import { createManagedExternalAgentJoin } from '#/handlers/session/handlers/managed-external-agent-join.ts';
import { createSessionMemberObservationHandlers } from '#/handlers/session/handlers/session-member-observation.ts';
import { createSessionMembersHandlers } from '#/handlers/session/handlers/session-members.ts';
import { SessionUiProjector } from '#/handlers/session/ui-projection.ts';
import { clearAcpDelegatesForSession } from '#/services/delegation/acp-delegate.ts';
import { createProjectLifecycleHandlers } from './lifecycle-projects.ts';
import { createWorkspaceHandlers, resolveWorkspaceDir } from './lifecycle-workspace.ts';

const log = createLogger('session');

const SESSION_DELETE_BACKEND_GRACE_MS = 8000;

type SessionProcessControlRequest = {
  action: 'stop';
  processId: string;
};

type SessionProcessControlResponse = {
  ok: true;
  action: 'stop';
  processId: string;
};

/** Identity-only origin fields for observability — NEVER the env block (PII). */
function originLog(origin?: SessionOrigin): Record<string, string | undefined> {
  return origin ? { surface: origin.surface, client: origin.client, transport: origin.transport } : {};
}

// Branch access: the PARENT's branchableBy governs who may fork it (orthogonal to writableBy). The
// branching transport is carried on the child origin the caller built. Parents with no origin, or
// callers that built no origin (no transport to match), are unrestricted.
function assertBranchAllowed(parent: Session, transport: SessionTransport | undefined): void {
  const branchableBy = parent.origin?.branchableBy;
  if (!branchableBy || !transport) return;
  if (!branchableBy.includes(transport)) {
    throw new HandlerError('forbidden', `transport '${transport}' cannot branch this session`);
  }
}

export function createLifecycleHandlers(ctx: SessionContext) {
  const {
    deps: { store, agent, oversight, delegation, sessionSandbox, hooks, hookCwd },
    aborts,
    requireSession,
    emitLifecycle,
    waitForRun
  } = ctx;
  const sessionDeleteGraceMs = ctx.deps.sessionDeleteGraceMs ?? SESSION_DELETE_BACKEND_GRACE_MS;

  const { spawnManagedSessionMember } = createManagedExternalAgentJoin(ctx);
  const { listSessionMembers, inviteSessionMember, spawnSessionMember, removeSessionMember } =
    createSessionMembersHandlers(ctx, { spawnManagedSessionMember });
  const { observeMemberUi, subscribeMemberUiObservation } = createSessionMemberObservationHandlers(ctx);

  const {
    applyWorkspaceRuntime,
    disposeRuntime,
    setWorkspace,
    workspaceMeta,
    workspaceGit,
    workspaceAction,
    configureRuntime
  } = createWorkspaceHandlers(ctx);

  const { listProjects, getProject, createProject, updateProject, deleteProject } = createProjectLifecycleHandlers(
    ctx,
    { resolveWorkspaceDir }
  );
  const pendingSessionDeletes = new Map<SessionId, ReturnType<typeof setTimeout>>();

  const isPendingSessionDelete = (id: SessionId) => pendingSessionDeletes.has(id);

  const listVisibleSessions = (
    filter: { archived?: boolean; projectId?: ProjectId; query?: string; state?: SessionState },
    limit: number,
    offset: number
  ) => {
    const sessions = store.listSessions(filter).filter((session) => !isPendingSessionDelete(session.id));
    return {
      limit,
      offset,
      sessions: sessions.slice(offset, offset + limit),
      total: sessions.length
    };
  };

  const hardDeleteSession = async (id: SessionId): Promise<boolean> => {
    const timer = pendingSessionDeletes.get(id);
    if (timer) clearTimeout(timer);
    pendingSessionDeletes.delete(id);
    const session = store.getSession(id);
    if (!session) return false;
    aborts.get(id)?.abort();
    aborts.delete(id);
    disposeRuntime(id);
    clearProcessesForSession(id);
    clearAcpDelegatesForSession(id); // kill any reused external ACP adapters held for this session
    ctx.deps.externalAgentHost?.stopSession(id);
    oversight?.cancelSession(id, 'session_deleted');
    delegation?.cancelSession(id, 'session_deleted');
    // SessionEnd fires before teardown (abort only pauses a turn, so it does not end the session).
    await fireSessionHook('SessionEnd', id);
    await sessionSandbox?.dispose(id);
    // Release any remote launcher instance kept for this session (e.g. an e2b cloud sandbox).
    disposeSandboxSession(id);
    store.deleteSessionMembers(id);
    store.deleteSession(id);
    emitLifecycle(id, 'session.deleted', {});
    return true;
  };

  // SessionStart/SessionEnd are observe-only here: SessionStart's additionalContext is stashed by the
  // runner and injected into the session's first turn; session lifecycle never blocks on a hook.
  const fireSessionHook = (
    event: 'SessionStart' | 'SessionEnd',
    sessionId: SessionId,
    reason?: 'completed' | 'aborted' | 'error'
  ): Promise<unknown> =>
    hooks?.run({
      event,
      sessionId,
      cwd: hookCwd ?? '',
      timestamp: new Date().toISOString(),
      ...(reason ? { reason } : {})
    }) ?? Promise.resolve();

  async function resolveAgentId(agentId?: AgentId): Promise<AgentId | undefined> {
    let resolvedId: AgentId | undefined = agentId;
    const cfg = ctx.deps.configManager?.get().cfg;
    if (!resolvedId && cfg) {
      if (cfg.agent.defaultAgentId) {
        resolvedId = cfg.agent.defaultAgentId as AgentId;
      } else if (cfg?.agent.agents.length) {
        throw new HandlerError('invalid', 'no agent specified and no default agent configured');
      }
    }
    if (resolvedId && cfg) {
      if (!cfg.agent.agents.some((a) => a.id === resolvedId)) {
        throw new HandlerError('invalid', `agent not found: ${resolvedId}`);
      }
    }
    return resolvedId;
  }

  return {
    async list(
      params: { archived?: boolean; query?: string; state?: SessionState; limit?: number; offset?: number } = {}
    ) {
      const limit = params.limit ?? 50;
      const offset = params.offset ?? 0;
      const filter = { archived: params.archived, query: params.query, state: params.state };
      return listVisibleSessions(filter, limit, offset);
    },

    listProjects,
    getProject,
    createProject,
    updateProject,
    deleteProject,

    listSessionMembers,
    inviteSessionMember,
    spawnSessionMember,
    removeSessionMember,
    observeMemberUi,
    subscribeMemberUiObservation,

    async get({ id }: { id: SessionId }) {
      if (isPendingSessionDelete(id)) throw new HandlerError('not_found', `session not found: ${id}`);
      return { session: requireSession(id) };
    },

    async create({
      title,
      agentId,
      origin,
      cwd
    }: {
      title: string;
      agentId?: AgentId;
      origin?: SessionOrigin;
      cwd?: string;
    }) {
      const resolvedId = await resolveAgentId(agentId);
      const resolvedCwd = cwd?.trim() ? resolveWorkspaceDir(cwd, undefined) : undefined;
      const session = await agent.sessions.create(title, resolvedId, origin, resolvedCwd);
      await sessionSandbox?.ensure(session.id);
      // Broaden the runtime sandbox to the working folder (so fs/shell + delegated subagents reach it)
      // and load its project-local skills — mirrors setWorkspace for the create-time entry point.
      if (session.cwd) await applyWorkspaceRuntime(session.id, session.cwd);
      log.info({ sessionId: session.id, ...originLog(origin) }, 'session created');
      emitLifecycle(session.id, 'session.created', { title: session.title });
      await fireSessionHook('SessionStart', session.id);
      return { sessionId: session.id };
    },

    /** A session under a Workplace Project (Track B) — no auto-created default (resolved decision 3),
     *  so this is the explicit entry point a project's UI calls to start its first (or an additional)
     *  session. Same lifecycle as a plain chat session, just tagged with `projectId`. */
    async createProjectSession({
      projectId,
      title,
      origin,
      cwd,
      id
    }: {
      projectId: ProjectId;
      title: string;
      origin?: SessionOrigin;
      cwd?: string;
      id?: SessionId;
    }) {
      const project = store.getWorkplaceProject(projectId);
      if (!project) {
        throw new HandlerError('not_found', `workplace project not found: ${projectId}`);
      }
      const cwdInput = cwd?.trim() ? cwd : project.cwd;
      const resolvedCwd = cwdInput ? resolveWorkspaceDir(cwdInput, undefined) : undefined;
      const session = await agent.sessions.createForProject(projectId, title, origin, resolvedCwd, id);
      const memberCreatedAt = session.createdAt;
      for (const template of project.memberTemplates) {
        store.insertSessionMember({
          sessionId: session.id,
          memberId: template.id,
          templateId: template.id,
          type: template.type,
          data: {
            name: template.name,
            ...(template.displayName ? { displayName: template.displayName } : {}),
            ...(template.settings ? { settings: template.settings } : {})
          },
          createdAt: memberCreatedAt,
          updatedAt: memberCreatedAt
        });
      }
      await sessionSandbox?.ensure(session.id);
      if (session.cwd) await applyWorkspaceRuntime(session.id, session.cwd);
      log.info({ sessionId: session.id, projectId, ...originLog(origin) }, 'project session created');
      emitLifecycle(session.id, 'session.created', { title: session.title });
      await fireSessionHook('SessionStart', session.id);
      return { sessionId: session.id };
    },

    async listProjectSessions({ limit, offset, projectId }: { limit?: number; offset?: number; projectId: ProjectId }) {
      if (!store.getWorkplaceProject(projectId)) {
        throw new HandlerError('not_found', `workplace project not found: ${projectId}`);
      }
      const resolvedLimit = limit ?? 50;
      const resolvedOffset = offset ?? 0;
      return listVisibleSessions({ projectId }, resolvedLimit, resolvedOffset);
    },

    async update({ id, title, state, archived, agentId, origin, cwd }: { id: SessionId } & UpdateSessionRequest) {
      const current = requireSession(id);
      if (state !== undefined && !canTransition(current.state, state)) {
        throw new HandlerError('invalid', `illegal state transition: ${current.state} -> ${state}`);
      }
      // The working folder carries a runtime side effect (sandbox + skills), so it goes through the
      // dedicated path; validation (absolute/existing/dir) happens there and rejects before any write.
      const resolvedCwd = cwd === undefined ? undefined : cwd.trim() ? resolveWorkspaceDir(cwd, current.cwd) : null;
      const resolvedAgentId = agentId === undefined || agentId === null ? agentId : await resolveAgentId(agentId);
      const session = store.updateSession(id, {
        title,
        state,
        archived,
        ...(resolvedAgentId !== undefined ? { agentIds: resolvedAgentId ? [resolvedAgentId] : [] } : {}),
        origin,
        ...(resolvedCwd !== undefined ? { cwd: resolvedCwd } : {})
      });
      if (!session) throw new HandlerError('internal', 'update failed');
      if (resolvedCwd !== undefined) await applyWorkspaceRuntime(id, resolvedCwd ?? undefined);
      emitLifecycle(id, 'session.updated', {
        title,
        state,
        archived,
        ...(resolvedCwd !== undefined ? { cwd: resolvedCwd } : {})
      });
      return { session };
    },

    setWorkspace,
    workspaceMeta,
    workspaceGit,
    workspaceAction,

    async sessionProcessControl({
      id,
      action,
      processId
    }: { id: SessionId } & SessionProcessControlRequest): Promise<SessionProcessControlResponse> {
      requireSession(id);
      await processControlTool.run(
        { action, id: processId },
        {
          sessionId: id,
          sandboxRoots: undefined,
          log: () => {}
        }
      );
      return { ok: true, action, processId };
    },

    async delete({ id }: { id: SessionId }) {
      requireSession(id);
      if (!pendingSessionDeletes.has(id)) {
        const timer = setTimeout(() => {
          void hardDeleteSession(id).catch((err) => log.warn({ err, sessionId: id }, 'pending session delete failed'));
        }, sessionDeleteGraceMs);
        (timer as { unref?: () => void }).unref?.();
        pendingSessionDeletes.set(id, timer);
      }
      return { deleted: true as const };
    },

    async undoDelete({ id }: { id: SessionId }) {
      const timer = pendingSessionDeletes.get(id);
      if (!timer) return { undone: false };
      clearTimeout(timer);
      pendingSessionDeletes.delete(id);
      return { undone: true };
    },

    configureRuntime,

    async reset({ id }: { id: SessionId }) {
      requireSession(id);
      aborts.get(id)?.abort();
      aborts.delete(id);
      clearProcessesForSession(id);
      clearAcpDelegatesForSession(id); // the sub-agent's continued context no longer matches a reset parent
      ctx.deps.externalAgentHost?.stopSession(id);
      const clearedCount = store.clearMessages(id);
      emitLifecycle(id, 'session.updated', { reset: true });
      return { clearedCount };
    },

    async abort({ id }: { id: SessionId }) {
      const current = requireSession(id);
      const controller = aborts.get(id);
      const aborted = controller !== undefined && !controller.signal.aborted;
      controller?.abort();
      oversight?.cancelSession(id, 'session_aborted');
      delegation?.cancelSession(id, 'session_aborted');
      if (aborted && canTransition(current.state, 'paused')) {
        store.updateSession(id, { state: 'paused' });
        emitLifecycle(id, 'session.updated', { state: 'paused' });
      }
      return { aborted };
    },

    async messages({
      id,
      limit,
      before,
      includeInactive
    }: {
      id: SessionId;
      limit?: number;
      before?: string;
      includeInactive?: boolean;
    }) {
      requireSession(id);
      return { messages: store.listMessages(id, { limit, before, includeInactive }) };
    },

    async uiItems({
      id,
      limit,
      before,
      after,
      around,
      includeInactive
    }: {
      id: SessionId;
      limit?: number;
      before?: string;
      after?: string;
      around?: string;
      includeInactive?: boolean;
    }): Promise<ListUiItemsResponse> {
      requireSession(id);
      // `around` opens an inclusive window centred on a message; `after` pages forward
      // (oldest-first from the cursor); otherwise take the newest window (optionally older than
      // `before`) — all returned oldest→newest by listMessages.
      const messages =
        around !== undefined
          ? store.listMessages(id, { limit, around, includeInactive })
          : after !== undefined
            ? store.listMessages(id, { limit, after, includeInactive })
            : store.listMessages(id, { limit, before, includeInactive, latest: true });
      const projector = new SessionUiProjector(ctx.deps.localeService ? { t: ctx.deps.localeService.t } : {});
      projector.hydrateMessages(messages, parseDurableSummary(store.getMemory(id, 'ctx:summary')));
      // Rebuild external agent tool cards from their durable snapshots for this window (external_agent.output
      // chunks aren't persisted as events). Scope to the page's time span so a card lands on the page
      // it belongs to; the full lineage view takes them all. Cross-page overlap is harmless — the
      // client merges transcript items by key.
      const cliSessions = store.listExternalAgentSessionsForTranscriptTarget(id);
      const oldestTs = messages.at(0)?.createdAt;
      const newestTs = messages.at(-1)?.createdAt;
      if (oldestTs !== undefined && newestTs !== undefined) {
        projector.hydrateExternalAgentSessions(
          cliSessions.filter((s) => s.startedAt >= oldestTs && s.startedAt <= newestTs)
        );
      }
      const snapshot = projector.snapshot();
      const items = snapshot.kind === 'snapshot' ? snapshot.items : [];
      const oldest = messages.at(0)?.id;
      const newest = messages.at(-1)?.id;
      const hasOlder =
        oldest !== undefined && store.listMessages(id, { before: oldest, includeInactive, limit: 1 }).length > 0;
      const hasNewer =
        newest !== undefined && store.listMessages(id, { after: newest, includeInactive, limit: 1 }).length > 0;
      return {
        items,
        ...(hasOlder ? { olderCursor: oldest as `msg_${string}` } : {}),
        ...(hasNewer ? { newerCursor: newest as `msg_${string}` } : {})
      };
    },

    async branch({ id, title, atMessageId, origin }: { id: SessionId; origin?: SessionOrigin } & BranchSessionRequest) {
      const parent = requireSession(id);
      assertBranchAllowed(parent, origin?.transport);
      const sourceMessages = store.listMessages(id);
      const targetIndex = atMessageId ? sourceMessages.findIndex((message) => message.id === atMessageId) : -1;
      if (atMessageId && targetIndex < 0) throw new HandlerError('invalid', `message not found: ${atMessageId}`);
      if (atMessageId && sourceMessages[targetIndex]?.role !== 'user') {
        throw new HandlerError('invalid', 'branch target must be a user message');
      }
      const snapshot = (targetIndex >= 0 ? sourceMessages.slice(0, targetIndex + 1) : sourceMessages).filter(
        (message) => message.type !== 'branch_source'
      );
      const target = targetIndex >= 0 ? sourceMessages[targetIndex] : sourceMessages.at(-1);
      const child = await agent.sessions.create(title ?? `${parent.title} (branch)`, undefined, origin, parent.cwd);
      store.cloneMessages(child.id, snapshot);
      // Cloned tool_call rows keep their toolCallIds, so the child's read_tool_output handles must
      // resolve against its own transcript id — copy the referenced spills alongside the messages.
      const snapshotToolCallIds = snapshot
        .filter((message) => message.type === 'tool_call')
        .map((message) => (message.data as { toolCallId?: unknown } | undefined)?.toolCallId)
        .filter((toolCallId): toolCallId is string => typeof toolCallId === 'string');
      store.cloneToolRawOutputs(id, child.id, snapshotToolCallIds);
      if (target) {
        const createdAt = new Date().toISOString();
        store.insertMessage(newId('msg'), child.id, '', createdAt, 'assistant', {
          data: { sessionTitle: parent.title },
          includeInContext: false,
          type: 'branch_source'
        });
      }
      log.info({ sessionId: child.id, ...originLog(origin) }, 'session branched');
      emitLifecycle(child.id, 'session.created', { title: child.title });
      return { sessionId: child.id };
    },

    async restore({ id, toMessageId }: { id: SessionId } & RestoreSessionRequest) {
      requireSession(id);
      const target = store.getMessage(id, toMessageId);
      if (!target) {
        throw new HandlerError('invalid', `message not found: ${toMessageId}`);
      }
      if (target.role !== 'user') {
        throw new HandlerError('invalid', 'restore target must be a user message');
      }
      const controller = aborts.get(id);
      controller?.abort();
      if (controller) {
        oversight?.cancelSession(id, 'session_aborted');
        delegation?.cancelSession(id, 'session_aborted');
      }
      await waitForRun(id);
      const raw = store.restoreMessages(id, toMessageId);
      const result: RestoreSessionResponse = {
        restoredCount: raw.restoredCount,
        newHeadMessageId: raw.newHeadMessageId as MessageId | null
      };
      emitLifecycle(id, 'session.restored', { toMessageId, ...result });
      return result;
    },

    /** List ACP delegate lifecycle records for a session (live + evicted), newest first. */
    async delegates({ id, limit }: { id: SessionId; limit?: number }) {
      requireSession(id);
      return { delegates: store.listAcpDelegatesForSession(id, limit) };
    }
  };
}
