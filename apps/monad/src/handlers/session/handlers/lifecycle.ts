import type {
  AgentId,
  BranchSessionRequest,
  ConfigureRuntimeRequest,
  ListUiItemsResponse,
  MessageId,
  PrincipalId,
  RestoreSessionRequest,
  RestoreSessionResponse,
  Session,
  SessionId,
  SessionOrigin,
  SessionState,
  SessionTransport,
  UpdateSessionRequest
} from '@monad/protocol';
import type { McpConnection } from '@/capabilities/tools';
import type { Tool, ToolBackends } from '@/capabilities/tools/types.ts';
import type { SessionContext } from '@/handlers/session/context.ts';

import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { loadAll } from '@monad/home';
import { createLogger } from '@monad/logger';

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
import { SessionUiProjector } from '@/handlers/session/ui-projection.ts';
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

/** Validate a working-folder path: absolute, existing, a directory. Returns the resolved path. */
function resolveWorkspaceDir(cwd: string): string {
  if (!isAbsolute(cwd)) throw new HandlerError('invalid', `working folder must be an absolute path: ${cwd}`);
  const resolved = resolve(cwd);
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
    emitLifecycle
  } = ctx;

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
  async function applyWorkspaceRuntime(id: SessionId, resolved: string | undefined): Promise<void> {
    const previous = runtime.get(id);
    const extraSkills = resolved && discoverProjectSkills ? await discoverProjectSkills(resolved).catch(() => []) : [];
    runtime.set(id, {
      ...previous,
      sandboxRoots: resolved ? [resolved] : undefined,
      extraSkills: extraSkills.length ? extraSkills : undefined
    });
  }

  /** Close + forget a session's out-of-band runtime config (MCP connections, sandbox roots). */
  function disposeRuntime(id: SessionId): void {
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
      const session = await agent.sessions.create(title, ownerPrincipalId, resolvedId, origin, cwd);
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
      const resolvedCwd = cwd === undefined ? undefined : cwd.trim() ? resolveWorkspaceDir(cwd) : null;
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

    /**
     * Set (or clear, with an empty string) the session's shared working folder. This is the single
     * source of truth behind every entry point (the `/workdir` command, the session update RPC, and
     * room creation): it persists `session.cwd`, broadens the session's runtime sandbox roots to that
     * folder so fs/shell tools — and any delegated subagent that inherits `ctx.sandboxRoots` — can
     * reach it, refreshes project-local skills from the folder, and fans a `session.updated` delta.
     */
    async setWorkspace({ id, cwd }: { id: SessionId; cwd: string }): Promise<Session> {
      requireSession(id);
      const resolved = cwd.trim() ? resolveWorkspaceDir(cwd) : undefined;
      const session = store.updateSession(id, { cwd: resolved ?? null });
      if (!session) throw new HandlerError('internal', 'set workspace failed');
      await applyWorkspaceRuntime(id, resolved);
      emitLifecycle(id, 'session.updated', { cwd: resolved ?? null });
      return session;
    },

    async delete({ id }: { id: SessionId }) {
      requireSession(id);
      aborts.get(id)?.abort();
      aborts.delete(id);
      disposeRuntime(id);
      clearProcessesForSession(id);
      clearAcpDelegatesForSession(id); // kill any reused external ACP adapters held for this session
      ctx.deps.nativeCliHost?.stopProject(id as SessionId);
      oversight?.cancelSession(id as SessionId, 'session_deleted');
      delegation?.cancelSession(id as SessionId, 'session_deleted');
      // SessionEnd fires before teardown (abort only pauses a turn, so it does not end the session).
      await fireSessionHook('SessionEnd', id as SessionId);
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

    async reset({ id }: { id: SessionId }) {
      requireSession(id);
      aborts.get(id)?.abort();
      aborts.delete(id);
      clearProcessesForSession(id);
      clearAcpDelegatesForSession(id); // the sub-agent's continued context no longer matches a reset parent
      ctx.deps.nativeCliHost?.stopProject(id as SessionId);
      const clearedCount = store.clearMessages(id);
      emitLifecycle(id, 'session.updated', { reset: true });
      return { clearedCount };
    },

    async abort({ id }: { id: SessionId }) {
      const current = requireSession(id);
      const controller = aborts.get(id);
      const aborted = controller !== undefined;
      controller?.abort();
      aborts.delete(id);
      oversight?.cancelSession(id as SessionId, 'session_aborted');
      delegation?.cancelSession(id as SessionId, 'session_aborted');
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
      includeInactive,
      includeAncestors
    }: {
      id: SessionId;
      limit?: number;
      before?: string;
      includeInactive?: boolean;
      includeAncestors?: boolean;
    }) {
      requireSession(id);
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
      id: SessionId;
      limit?: number;
      before?: string;
      after?: string;
      around?: string;
      includeInactive?: boolean;
      includeAncestors?: boolean;
    }): Promise<ListUiItemsResponse> {
      requireSession(id);
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
