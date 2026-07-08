import type {
  ConfigureRuntimeRequest,
  Session,
  SessionId,
  WorkspaceActionRequest,
  WorkspaceActionResponse
} from '@monad/protocol';
import type { McpConnection } from '#/capabilities/tools';
import type { Tool, ToolBackends } from '#/capabilities/tools/types.ts';
import type { SessionContext } from '#/handlers/session/context.ts';

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { connectMcpServer, createSandboxBackends, isDelegableTool } from '#/capabilities/tools';
import { HandlerError } from '#/handlers/handler-error.ts';
import { runWorkspaceAction } from '#/handlers/session/workspace-actions.ts';
import { readWorkspaceGit } from '#/handlers/session/workspace-git.ts';
import { createRemoteFsBackend, createRemoteTerminalBackend } from '#/services/delegation/delegation.ts';

/** Resolve + validate a working-folder path: expands a leading `~`, resolves a relative path against
 *  `base` (the session's current folder), then requires it to exist and be a directory. A relative
 *  path with no base is rejected. Returns the absolute resolved path. */
export function resolveWorkspaceDir(cwd: string, base: string | undefined): string {
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

/** Per-transcript-target runtime config (sandbox roots, MCP tools/connections, delegation) and the
 *  RPC handlers that read/write it: setWorkspace, workspaceMeta/Git, workspaceAction, configureRuntime.
 *  Extracted from lifecycle.ts because this cluster is self-contained apart from two shared entry
 *  points — applyWorkspaceRuntime/disposeRuntime, which lifecycle.ts and lifecycle-projects.ts also
 *  call directly from create/update/delete, so they're returned alongside the handlers. */
export function createWorkspaceHandlers(ctx: SessionContext) {
  const {
    deps: { discoverProjectSkills, delegation },
    runtime,
    requireSession,
    emitLifecycle
  } = ctx;

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

  return {
    applyWorkspaceRuntime,
    disposeRuntime,

    /**
     * Set (or clear, with an empty string) the transcript target's shared working folder. This is the
     * single source of truth behind every entry point (the `/workdir` command, session/project update
     * RPCs, and room creation): it persists cwd, broadens the runtime sandbox roots to that folder so
     * fs/shell tools — and any delegated subagent that inherits `ctx.sandboxRoots` — can reach it,
     * refreshes project-local skills from the folder, and fans a `session.updated` delta.
     */
    async setWorkspace({ id, cwd }: { id: SessionId; cwd: string }): Promise<Session> {
      const current = requireSession(id);
      const resolved = cwd.trim() ? resolveWorkspaceDir(cwd, current.cwd) : undefined;
      const updated = ctx.deps.store.updateSession(id, { cwd: resolved ?? null });
      if (!updated) throw new HandlerError('internal', 'set workspace failed');
      await applyWorkspaceRuntime(id, resolved);
      emitLifecycle(id, 'session.updated', { cwd: resolved ?? null });
      return updated;
    },

    /** Best-effort workspace metadata for the session's working folder. No folder → not a git repo. */
    async workspaceMeta({ id }: { id: SessionId }) {
      const session = requireSession(id);
      return { git: session.cwd ? await readWorkspaceGit(session.cwd) : { isRepo: false } };
    },

    /** Backward-compatible alias for callers that still read only the git slice. */
    async workspaceGit({ id }: { id: SessionId }) {
      const session = requireSession(id);
      return session.cwd ? await readWorkspaceGit(session.cwd) : { isRepo: false };
    },

    async workspaceAction({
      id,
      action
    }: { id: SessionId } & WorkspaceActionRequest): Promise<WorkspaceActionResponse> {
      const session = requireSession(id);
      if (!session.cwd) throw new HandlerError('invalid', 'working folder is not set');
      await runWorkspaceAction(action, session.cwd);
      return { ok: true, action };
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
          ctx.deps.log?.warn(
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
    }
  };
}
