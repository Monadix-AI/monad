import type {
  AgentId,
  BranchSessionRequest,
  ConfigureRuntimeRequest,
  ListUiItemsResponse,
  MessageId,
  PrincipalId,
  ProjectId,
  RestoreSessionRequest,
  RestoreSessionResponse,
  Session,
  SessionId,
  SessionOrigin,
  SessionState,
  SessionTransport,
  TranscriptTargetId,
  UpdateSessionRequest,
  UpdateWorkplaceProjectRequest,
  WorkplaceProject,
  WorkspaceActionRequest,
  WorkspaceActionResponse
} from '@monad/protocol';
import type { McpConnection } from '@/capabilities/tools';
import type { Tool, ToolBackends } from '@/capabilities/tools/types.ts';
import type { SessionContext } from '@/handlers/session/context.ts';

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { loadAll } from '@monad/home';
import { createLogger } from '@monad/logger';
import { newId } from '@monad/protocol';

import { parseDurableSummary } from '@/agent/history.ts';
import { canTransition } from '@/agent/index.ts';
import {
  clearProcessesForSession,
  connectMcpServer,
  createSandboxBackends,
  disposeSandboxSession,
  isDelegableTool
} from '@/capabilities/tools';
import { HandlerError } from '@/handlers/handler-error.ts';
import { createManagedNativeCliJoin } from '@/handlers/session/handlers/managed-native-cli-join.ts';
import { SessionUiProjector } from '@/handlers/session/ui-projection.ts';
import { runWorkspaceAction } from '@/handlers/session/workspace-actions.ts';
import { readWorkspaceGit } from '@/handlers/session/workspace-git.ts';
import { clearAcpDelegatesForSession } from '@/services/delegation/acp-delegate.ts';
import { createRemoteFsBackend, createRemoteTerminalBackend } from '@/services/delegation/delegation.ts';

const log = createLogger('session');

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

/** Resolve + validate a working-folder path: expands a leading `~`, resolves a relative path against
 *  `base` (the session's current folder), then requires it to exist and be a directory. A relative
 *  path with no base is rejected. Returns the absolute resolved path. */
function resolveWorkspaceDir(cwd: string, base: string | undefined): string {
  const expanded = cwd === '~' ? homedir() : cwd.startsWith('~/') ? join(homedir(), cwd.slice(2)) : cwd;
  if (!isAbsolute(expanded) && !base) {
    throw new HandlerError('invalid', `working folder must be an absolute path or start with ~: ${cwd}`);
  }
  const resolved = isAbsolute(expanded) ? resolve(expanded) : resolve(base as string, expanded);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(resolved);
  } catch {
    throw new HandlerError('invalid', `working folder does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) throw new HandlerError('invalid', `working folder is not a directory: ${resolved}`);
  return resolved;
}

export function createLifecycleHandlers(ctx: SessionContext) {
  const {
    deps: {
      store,
      agent,
      ownerPrincipalId,
      paths,
      oversight,
      delegation,
      sessionSandbox,
      hooks,
      hookCwd,
      discoverProjectSkills
    },
    aborts,
    runtime,
    requireSession,
    requireTranscriptTarget,
    emitLifecycle
  } = ctx;

  const { startAddedManagedNativeCliMembers } = createManagedNativeCliJoin(ctx);

  function projectView(project: WorkplaceProject): WorkplaceProject {
    return {
      id: project.id,
      title: project.title,
      ownerPrincipalId: project.ownerPrincipalId,
      state: project.state,
      archived: project.archived,
      ...(project.model ? { model: project.model } : {}),
      ...(project.cwd ? { cwd: project.cwd } : {}),
      ...(project.origin ? { origin: project.origin } : {}),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt
    };
  }

  function requireProject(id: ProjectId): WorkplaceProject {
    const project = store.getWorkplaceProject(id);
    if (!project) throw new HandlerError('invalid', `workplace project not found: ${id}`);
    return project;
  }

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

  /** Broaden a session's runtime sandbox roots to its working folder (so fs/shell tools and any
   *  delegated subagent that inherits `ctx.sandboxRoots` can reach it) and refresh project-local
   *  skills from it. `resolved === undefined` clears the override back to the daemon/agent default.
   *  The working folder fully determines both fields, so switching/clearing it drops the prior
   *  folder's skills (no stale carry-over); other runtime config (MCP tools/connections) survives. */
  async function applyWorkspaceRuntime(id: TranscriptTargetId, resolved: string | undefined): Promise<void> {
    const previous = runtime.get(id);
    const extraSkills = resolved && discoverProjectSkills ? await discoverProjectSkills(resolved).catch(() => []) : [];
    runtime.set(id, {
      ...previous,
      sandboxRoots: resolved ? [resolved] : undefined,
      extraSkills: extraSkills.length ? extraSkills : undefined
    });
  }

  /** Close + forget a session's out-of-band runtime config (MCP connections, sandbox roots). */
  function disposeRuntime(id: TranscriptTargetId): void {
    const rt = runtime.get(id);
    if (!rt) return;
    for (const conn of rt.mcpConnections ?? []) void conn.close().catch(() => {});
    runtime.delete(id);
  }

  async function resolveAgentId(agentId?: AgentId): Promise<AgentId | undefined> {
    let resolvedId: AgentId | undefined = agentId;
    if (!resolvedId && paths) {
      const cfg = await loadAll(paths.config, paths.profile);
      if (cfg?.agent.defaultAgentId) {
        resolvedId = cfg.agent.defaultAgentId as AgentId;
      } else if (cfg?.agent.agents.length) {
        throw new HandlerError('invalid', 'no agent specified and no default agent configured');
      }
    }
    if (resolvedId && paths) {
      const cfg = await loadAll(paths.config, paths.profile);
      if (cfg && !cfg.agent.agents.some((a) => a.id === resolvedId)) {
        throw new HandlerError('invalid', `agent not found: ${resolvedId}`);
      }
    }
    return resolvedId;
  }

  return {
    async list(params: { archived?: boolean; state?: SessionState; limit?: number; offset?: number } = {}) {
      const limit = params.limit ?? 50;
      const offset = params.offset ?? 0;
      const filter = { archived: params.archived, state: params.state };
      return {
        sessions: store.listSessions({ ...filter, limit, offset }),
        total: store.countSessions(filter),
        limit,
        offset
      };
    },

    async listProjects(params: { archived?: boolean; state?: SessionState; limit?: number; offset?: number } = {}) {
      const limit = params.limit ?? 50;
      const offset = params.offset ?? 0;
      const filter = { archived: params.archived, state: params.state };
      return {
        projects: store.listWorkplaceProjects({ ...filter, limit, offset }).map(projectView),
        total: store.countWorkplaceProjects(filter),
        limit,
        offset
      };
    },

    async getProject({ id }: { id: ProjectId }) {
      return { project: projectView(requireProject(id)) };
    },

    async createProject({ title, origin, cwd }: { title: string; origin?: SessionOrigin; cwd?: string }) {
      const resolvedCwd = cwd?.trim() ? resolveWorkspaceDir(cwd, undefined) : undefined;
      const now = new Date().toISOString();
      const project: WorkplaceProject = {
        id: newId('prj'),
        title,
        ownerPrincipalId,
        state: 'active',
        archived: false,
        ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
        ...(origin ? { origin } : {}),
        createdAt: now,
        updatedAt: now
      };
      store.insertWorkplaceProject(project);
      await sessionSandbox?.ensure(project.id);
      if (project.cwd) await applyWorkspaceRuntime(project.id, project.cwd);
      log.info({ projectId: project.id, ...originLog(origin) }, 'workplace project created');
      emitLifecycle(project.id, 'session.created', {
        title: project.title,
        kind: 'workplace_project'
      });
      return { projectId: project.id };
    },

    async updateProject({
      id,
      title,
      state,
      archived,
      origin,
      cwd,
      model
    }: { id: ProjectId } & UpdateWorkplaceProjectRequest) {
      const current = requireProject(id);
      if (state !== undefined && !canTransition(current.state, state)) {
        throw new HandlerError('invalid', `illegal state transition: ${current.state} -> ${state}`);
      }
      const resolvedCwd =
        cwd === undefined ? undefined : cwd === null ? null : cwd.trim() ? resolveWorkspaceDir(cwd, current.cwd) : null;
      const project = store.updateWorkplaceProject(id, {
        title,
        state,
        archived,
        model,
        origin,
        ...(resolvedCwd !== undefined ? { cwd: resolvedCwd } : {})
      });
      if (!project) throw new HandlerError('internal', 'update project failed');
      if (resolvedCwd !== undefined) await applyWorkspaceRuntime(id, resolvedCwd ?? undefined);
      await startAddedManagedNativeCliMembers(current, project);
      emitLifecycle(id, 'session.updated', {
        title,
        state,
        archived,
        ...(resolvedCwd !== undefined ? { cwd: resolvedCwd } : {}),
        kind: 'workplace_project'
      });
      return { project: projectView(project) };
    },

    async deleteProject({ id }: { id: ProjectId }) {
      requireProject(id);
      aborts.get(id)?.abort();
      aborts.delete(id);
      disposeRuntime(id);
      clearProcessesForSession(id);
      ctx.deps.nativeCliHost?.stopTranscriptTarget(id);
      await sessionSandbox?.dispose(id);
      disposeSandboxSession(id);
      store.deleteWorkplaceProject(id);
      emitLifecycle(id, 'session.deleted', { kind: 'workplace_project' });
      return { deleted: true as const };
    },

    async get({ id }: { id: SessionId }) {
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
      const session = await agent.sessions.create(title, ownerPrincipalId, resolvedId, origin, resolvedCwd);
      await sessionSandbox?.ensure(session.id);
      // Broaden the runtime sandbox to the working folder (so fs/shell + delegated subagents reach it)
      // and load its project-local skills — mirrors setWorkspace for the create-time entry point.
      if (session.cwd) await applyWorkspaceRuntime(session.id, session.cwd);
      log.info({ sessionId: session.id, ...originLog(origin) }, 'session created');
      emitLifecycle(session.id, 'session.created', { title: session.title });
      await fireSessionHook('SessionStart', session.id);
      return { sessionId: session.id };
    },

    /**
     * Internal-only create that binds a CALLER-supplied principal instead of the daemon
     * owner. Not exposed over any RPC/HTTP route — used by the channel gateway so an external
     * IM user's session is owned by a restricted synthetic principal, never the owner.
     */
    async createForPrincipal({
      title,
      agentId,
      principalId,
      origin
    }: {
      title: string;
      agentId?: AgentId;
      principalId: PrincipalId;
      origin?: SessionOrigin;
    }) {
      const resolvedId = await resolveAgentId(agentId);
      const session = await agent.sessions.create(title, principalId, resolvedId, origin);
      await sessionSandbox?.ensure(session.id);
      log.info({ sessionId: session.id, principalId, ...originLog(origin) }, 'session created (principal)');
      emitLifecycle(session.id, 'session.created', { title: session.title });
      await fireSessionHook('SessionStart', session.id);
      return { sessionId: session.id };
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
      await startAddedManagedNativeCliMembers(current, session);
      emitLifecycle(id, 'session.updated', {
        title,
        state,
        archived,
        ...(resolvedCwd !== undefined ? { cwd: resolvedCwd } : {})
      });
      return { session };
    },

    /**
     * Set (or clear, with an empty string) the transcript target's shared working folder. This is the
     * single source of truth behind every entry point (the `/workdir` command, session/project update
     * RPCs, and room creation): it persists cwd, broadens the runtime sandbox roots to that folder so
     * fs/shell tools — and any delegated subagent that inherits `ctx.sandboxRoots` — can reach it,
     * refreshes project-local skills from the folder, and fans a `session.updated` delta.
     */
    async setWorkspace({ id, cwd }: { id: TranscriptTargetId; cwd: string }): Promise<Session | WorkplaceProject> {
      const current = requireTranscriptTarget(id);
      const resolved = cwd.trim() ? resolveWorkspaceDir(cwd, current.cwd) : undefined;
      const updatedSession = store.updateSession(id, { cwd: resolved ?? null });
      const updatedProject = updatedSession
        ? null
        : store.updateWorkplaceProject(id as ProjectId, { cwd: resolved ?? null });
      if (!updatedSession && !updatedProject) throw new HandlerError('internal', 'set workspace failed');
      await applyWorkspaceRuntime(id, resolved);
      emitLifecycle(id, 'session.updated', { cwd: resolved ?? null });
      return updatedSession ?? (updatedProject as WorkplaceProject);
    },

    /** Best-effort workspace metadata for the session's working folder. No folder → not a git repo. */
    async workspaceMeta({ id }: { id: TranscriptTargetId }) {
      const session = requireTranscriptTarget(id);
      return { git: session.cwd ? await readWorkspaceGit(session.cwd) : { isRepo: false } };
    },

    /** Backward-compatible alias for callers that still read only the git slice. */
    async workspaceGit({ id }: { id: SessionId }) {
      const session = requireTranscriptTarget(id);
      return session.cwd ? await readWorkspaceGit(session.cwd) : { isRepo: false };
    },

    async workspaceAction({
      id,
      action
    }: { id: TranscriptTargetId } & WorkspaceActionRequest): Promise<WorkspaceActionResponse> {
      const session = requireTranscriptTarget(id);
      if (!session.cwd) throw new HandlerError('invalid', 'working folder is not set');
      await runWorkspaceAction(action, session.cwd);
      return { ok: true, action };
    },

    async delete({ id }: { id: SessionId }) {
      requireSession(id);
      aborts.get(id)?.abort();
      aborts.delete(id);
      disposeRuntime(id);
      clearProcessesForSession(id);
      clearAcpDelegatesForSession(id); // kill any reused external ACP adapters held for this session
      ctx.deps.nativeCliHost?.stopTranscriptTarget(id);
      oversight?.cancelSession(id, 'session_deleted');
      delegation?.cancelSession(id, 'session_deleted');
      // SessionEnd fires before teardown (abort only pauses a turn, so it does not end the session).
      await fireSessionHook('SessionEnd', id);
      await sessionSandbox?.dispose(id);
      // Release any remote launcher instance kept for this session (e.g. an e2b cloud sandbox).
      disposeSandboxSession(id);
      store.deleteSession(id);
      emitLifecycle(id, 'session.deleted', {});
      return { deleted: true as const };
    },

    // Out-of-band per-turn execution config: the ACP bridge pushes the editor's sandbox roots and
    // session-scoped MCP servers. Replaces the stored runtime for the session (closing any prior MCP
    // connections first); messaging reads it on every turn. Idempotent — safe to call on session/new,
    // load, resume, fork, and (with no args) on close to release the session's resources.
    // The connected MCP servers spawn on the daemon host — acceptable because the bridge only ever
    // targets the LOCAL daemon (launch.ts), so the local editor remains the trust boundary; their
    // tools are high-risk by construction and still route through the oversight gate per call.
    async configureRuntime({ id, sandboxRoots, mcpServers, delegate }: { id: SessionId } & ConfigureRuntimeRequest) {
      requireSession(id);
      const previous = runtime.get(id);
      const hasRuntimeInput = sandboxRoots !== undefined || mcpServers !== undefined || delegate !== undefined;
      disposeRuntime(id); // close any prior session MCP connections before reconfiguring
      const conns: McpConnection[] = [];
      const tools: Tool[] = [];
      for (const spec of mcpServers ?? []) {
        try {
          const conn = await connectMcpServer(spec);
          conns.push(conn);
          tools.push(...conn.tools);
        } catch (err) {
          log.warn(
            { session: id, mcp: spec.name, err: err instanceof Error ? err.message : String(err) },
            'session MCP connect failed — skipped'
          );
        }
      }
      // Reverse delegation: when the client advertised fs/terminal capability, route those ops back to
      // the editor (DelegationService) instead of the daemon sandbox; non-delegated capabilities fall
      // back to the sandbox over the session roots. Filtering drops daemon-host tools. Requires a
      // DelegationService (absent in the in-process test harness — there delegation rides runOpts).
      let backends: ToolBackends | undefined;
      let toolFilter: ((toolName: string) => boolean) | undefined;
      if (delegation && delegate && (delegate.fs || delegate.terminal)) {
        const sandbox = createSandboxBackends(sandboxRoots, { sessionId: id });
        backends = {
          fs: delegate.fs ? createRemoteFsBackend(delegation, id) : sandbox.fs,
          terminal: delegate.terminal ? createRemoteTerminalBackend(delegation, id) : sandbox.terminal
        };
        toolFilter = isDelegableTool;
      }
      runtime.set(id, {
        sandboxRoots,
        extraTools: tools.length ? tools : undefined,
        mcpServers: mcpServers?.length ? mcpServers : undefined,
        mcpConnections: conns.length ? conns : undefined,
        backends,
        toolFilter,
        extraSkills: hasRuntimeInput ? previous?.extraSkills : undefined
      });
      return { ok: true as const };
    },

    async reset({ id }: { id: TranscriptTargetId }) {
      requireTranscriptTarget(id);
      aborts.get(id)?.abort();
      aborts.delete(id);
      clearProcessesForSession(id);
      clearAcpDelegatesForSession(id); // the sub-agent's continued context no longer matches a reset parent
      ctx.deps.nativeCliHost?.stopTranscriptTarget(id);
      const clearedCount = store.clearMessages(id);
      emitLifecycle(id, 'session.updated', { reset: true });
      return { clearedCount };
    },

    async abort({ id }: { id: TranscriptTargetId }) {
      const current = requireTranscriptTarget(id);
      const controller = aborts.get(id);
      const aborted = controller !== undefined;
      controller?.abort();
      aborts.delete(id);
      if (id.startsWith('ses_')) {
        const sessionId = id as SessionId;
        oversight?.cancelSession(sessionId, 'session_aborted');
        delegation?.cancelSession(sessionId, 'session_aborted');
      }
      if (aborted && canTransition(current.state, 'paused')) {
        if (store.getSession(id)) store.updateSession(id, { state: 'paused' });
        else store.updateWorkplaceProject(id, { state: 'paused' });
        emitLifecycle(id, 'session.updated', { state: 'paused' });
      }
      return { aborted };
    },

    async messages({
      id,
      limit,
      before,
      includeInactive,
      includeAncestors
    }: {
      id: TranscriptTargetId;
      limit?: number;
      before?: string;
      includeInactive?: boolean;
      includeAncestors?: boolean;
    }) {
      requireTranscriptTarget(id);
      if (!includeAncestors) {
        return { messages: store.listMessages(id, { limit, before, includeInactive }) };
      }
      return { messages: store.listMessagesWithLineage(id, { includeInactive }) };
    },

    async uiItems({
      id,
      limit,
      before,
      after,
      around,
      includeInactive,
      includeAncestors
    }: {
      id: TranscriptTargetId;
      limit?: number;
      before?: string;
      after?: string;
      around?: string;
      includeInactive?: boolean;
      includeAncestors?: boolean;
    }): Promise<ListUiItemsResponse> {
      requireTranscriptTarget(id);
      // `around` opens an inclusive window centred on a message; `after` pages forward
      // (oldest-first from the cursor); otherwise take the newest window (optionally older than
      // `before`) — all returned oldest→newest by listMessages.
      const messages = includeAncestors
        ? store.listMessagesWithLineage(id, { includeInactive })
        : around !== undefined
          ? store.listMessages(id, { limit, around, includeInactive })
          : after !== undefined
            ? store.listMessages(id, { limit, after, includeInactive })
            : store.listMessages(id, { limit, before, includeInactive, latest: true });
      const projector = new SessionUiProjector();
      projector.hydrateMessages(messages, parseDurableSummary(store.getMemory(id, 'ctx:summary')));
      // Rebuild native CLI tool cards from their durable snapshots for this window (native_cli.output
      // chunks aren't persisted as events). Scope to the page's time span so a card lands on the page
      // it belongs to; the full lineage view takes them all. Cross-page overlap is harmless — the
      // client merges transcript items by key.
      const cliSessions = store.listNativeCliSessionsForTranscriptTarget(id);
      if (includeAncestors) projector.hydrateNativeCliSessions(cliSessions);
      else {
        const oldestTs = messages.at(0)?.createdAt;
        const newestTs = messages.at(-1)?.createdAt;
        if (oldestTs !== undefined && newestTs !== undefined) {
          projector.hydrateNativeCliSessions(
            cliSessions.filter((s) => s.startedAt >= oldestTs && s.startedAt <= newestTs)
          );
        }
      }
      const snapshot = projector.snapshot();
      const items = snapshot.kind === 'snapshot' ? snapshot.items : [];
      if (includeAncestors) return { items };
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
      const child = await agent.sessions.branch(
        id,
        ownerPrincipalId,
        title ?? `${parent.title} (branch)`,
        atMessageId,
        origin
      );
      log.info({ sessionId: child.id, parentSessionId: id, ...originLog(origin) }, 'session branched');
      emitLifecycle(id, 'session.branched', { childId: child.id, atMessageId });
      emitLifecycle(child.id, 'session.created', { title: child.title, parentSessionId: id });
      return { sessionId: child.id };
    },

    async provenance({ id }: { id: SessionId }) {
      const self = requireSession(id);
      const { ancestors, descendants } = store.provenance(id);
      return { ancestors, self, descendants };
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
