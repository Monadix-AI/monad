import type {
  AgentConnection,
  AuthenticateRequest,
  CancelNotification,
  ClientCapabilities,
  CloseSessionRequest,
  CloseSessionResponse,
  DeleteSessionRequest,
  DeleteSessionResponse,
  DidChangeDocumentNotification,
  DidCloseDocumentNotification,
  DidFocusDocumentNotification,
  DidOpenDocumentNotification,
  DidSaveDocumentNotification,
  ForkSessionRequest,
  ForkSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  McpServer,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse
} from '@agentclientprotocol/sdk';
import type { AgentErrorPayload, AgentId, Event, FinishReason, MessageId, SessionId } from '@monad/protocol';
import type { McpServerSpec } from '#/capabilities/tools';
import type { ToolBackends } from '#/capabilities/tools/types.ts';
import type { AcpSession, Handlers } from '#/transports/acp/types.ts';

import { PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import { createLogger, formatTransportCall } from '@monad/logger';
import { parseEventPayload } from '@monad/protocol';

import { createSandboxBackends, isDelegableTool } from '#/capabilities/tools';
import { VERSION } from '#/handlers/daemon-handlers/index.ts';
import { buildSessionOrigin, hostOs } from '#/handlers/session/origin.ts';
import { createAcpFsBackend, createAcpTerminalBackend } from '#/transports/acp/backends.ts';
import { bridgeClarify, bridgeDelegation, bridgePermission } from '#/transports/acp/bridges.ts';
import { applyRangeEdit, renderOpenDocs } from '#/transports/acp/documents.ts';
import { acpExt, MONAD_EXT_METHODS, monadMeta, toMcpSpec } from '#/transports/acp/meta.ts';
import {
  eventToPlanUpdate,
  eventToSessionUpdate,
  finishReasonToStopReason,
  promptToAttachments,
  promptToText
} from '#/transports/acp/translate.ts';

const log = createLogger('transport:acp');

function logAcpCall(method: string, fields: Record<string, unknown> = {}): void {
  const record = { method, ...fields };
  log.trace(record, formatTransportCall(record));
}

export class MonadAcpAgent {
  private readonly sessions = new Map<SessionId, AcpSession>();
  private clientCaps: ClientCapabilities = {};
  /** Editor identity from `initialize` (vscode/zed/…); recorded in each session's origin. */
  private clientInfo: { name: string; version?: string } | undefined;
  private disconnected = false;

  constructor(
    private readonly conn: AgentConnection,
    private readonly handlers: Handlers,
    readonly _sandboxRoots: string[] | undefined
  ) {
    // When the ACP connection closes (editor disconnect / stdin EOF), abort every in-flight
    // session so their run loops don't continue burning resources on a dead connection.
    const disconnect = () => this.abortAllSessions();
    conn.signal.addEventListener('abort', disconnect, { once: true });
    void conn.closed.finally(disconnect);
  }

  private abortAllSessions(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const sid of this.sessions.keys()) {
      void this.handlers.session.abort({ id: sid }).catch(() => {});
    }
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    const t0 = performance.now();
    this.clientCaps = params.clientCapabilities ?? {};
    if (params.clientInfo) this.clientInfo = { name: params.clientInfo.name, version: params.clientInfo.version };
    // We only speak v1. Echo the client's version when we support it, else our latest.
    const protocolVersion = params.protocolVersion <= PROTOCOL_VERSION ? params.protocolVersion : PROTOCOL_VERSION;
    const result = {
      protocolVersion,
      agentInfo: { name: 'monad', version: VERSION },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        // fork→branch (time-travel); list→session.list; delete→session.delete; close→abort;
        // resume→re-attach without replay.
        sessionCapabilities: { fork: {}, list: {}, delete: {}, close: {}, resume: {}, additionalDirectories: {} },
        // Accept editor document-sync notifications; positions are utf-16 (JS string semantics).
        positionEncoding: 'utf-16' as const,
        // monad-specific extensions over the ACP `_meta` channel; callable via extMethod.
        _meta: { monad: { extMethods: MONAD_EXT_METHODS } }
      }
    };
    logAcpCall('initialize', { durationMs: Math.round(performance.now() - t0) });
    return result;
  }

  // The stdio channel's filesystem permissions are the trust boundary; no ACP-level auth.
  async authenticate(_params: AuthenticateRequest): Promise<void> {
    logAcpCall('authenticate');
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const t0 = performance.now();
    // Multi-agent: a monad-aware client can pick which configured agent runs the session via
    // `_meta.monad.agentId`; otherwise the daemon's default agent is used.
    const agentId = monadMeta(params._meta)?.agentId as AgentId | undefined;
    const origin = buildSessionOrigin({
      transport: 'acp',
      surface: 'editor',
      client: this.clientInfo?.name ?? 'acp',
      clientVersion: this.clientInfo?.version,
      env: { workspace: params.cwd, os: hostOs() },
      ext: acpExt(params._meta)
    });
    const { sessionId } = await this.handlers.session.create({ title: 'ACP session', agentId, origin });
    const sid = sessionId as SessionId;
    await this.registerSession(sid, params.cwd, params.mcpServers, params.additionalDirectories);
    // Guard: if the connection closed while session setup was in-flight, the abort handler may
    // have already iterated this.sessions and missed this entry (it wasn't there yet).  Clean up now.
    if (this.conn.signal.aborted) {
      void this.handlers.session.abort({ id: sid }).catch(() => {});
      this.sessions.delete(sid);
      throw new Error('Connection closed during session setup');
    }

    void this.sendAvailableCommands(sid);
    void this.sendSessionInfo(sid);
    // Surface monad's multi-agent info so clients can show which agent(s) own the session.
    const { session } = await this.handlers.session.get({ id: sid });
    logAcpCall('newSession', { sessionId, durationMs: Math.round(performance.now() - t0) });
    return { sessionId, _meta: { monad: { agentIds: session.agentIds } } };
  }

  /** **UNSTABLE** session/fork → monad's branch (time-travel). Forks at the source session's head
   * (ACP has no fork-point); the new session inherits the same delegation decision. */
  async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    const t0 = performance.now();
    const origin = buildSessionOrigin({
      transport: 'acp',
      surface: 'editor',
      client: this.clientInfo?.name ?? 'acp',
      clientVersion: this.clientInfo?.version,
      env: { workspace: params.cwd, os: hostOs() },
      ext: acpExt(params._meta)
    });
    const { sessionId } = await this.handlers.session.branch({ id: params.sessionId as SessionId, origin });
    const sid = sessionId as SessionId;
    await this.registerSession(sid, params.cwd, params.mcpServers, params.additionalDirectories);
    if (this.conn.signal.aborted) {
      void this.handlers.session.abort({ id: sid }).catch(() => {});
      this.sessions.delete(sid);
      throw new Error('Connection closed during session setup');
    }
    logAcpCall('forkSession', { from: params.sessionId, sessionId, durationMs: Math.round(performance.now() - t0) });
    return { sessionId };
  }

  /** Record per-session adapter state: decide fs/terminal delegation from the client's caps, and
   * connect any client-provided MCP servers so their tools are available this session.
   * Delegate per advertised capability; fall back to the daemon sandbox for what the client can't
   * take. When anything is delegated, drop tools that would still run on the daemon host. */
  private async registerSession(
    sid: SessionId,
    cwd: string,
    mcpServers?: McpServer[],
    additionalDirectories?: string[]
  ): Promise<void> {
    // ACP trusts the client's directories (it's user-controlled) — use them as the session sandbox
    // roots for non-delegated fs/shell, replacing the daemon's configured roots.
    const sandboxRoots = [cwd, ...(additionalDirectories ?? [])];
    const fsCap = !!(this.clientCaps.fs?.readTextFile && this.clientCaps.fs?.writeTextFile);
    const termCap = this.clientCaps.terminal === true;
    let backends: ToolBackends | undefined;
    let toolFilter: ((toolName: string) => boolean) | undefined;
    if (fsCap || termCap) {
      const sandbox = createSandboxBackends(sandboxRoots);
      backends = {
        fs: fsCap ? createAcpFsBackend(this.conn.client, sid) : sandbox.fs,
        terminal: termCap ? createAcpTerminalBackend(this.conn.client, sid) : sandbox.terminal
      };
      toolFilter = isDelegableTool;
    }
    this.sessions.set(sid, {
      cwd,
      cancelled: false,
      backends,
      toolFilter,
      openDocs: new Map(),
      sandboxRoots
    });
    // Push the session's sandbox roots AND client-provided MCP servers to the daemon, which owns the
    // loop. The daemon connects the MCP servers (their tools join every turn) and scopes fs/shell to
    // these roots — both applied out-of-band since runOpts can't cross the bridge wire. The ACP MCP
    // descriptors map to monad's connect spec here (unsupported transports drop to null).
    const mcpSpecs = (mcpServers ?? []).map(toMcpSpec).filter((s): s is McpServerSpec => s !== null);
    // Tell the daemon which capabilities to delegate back to this editor: it installs REMOTE fs/
    // terminal backends (DelegationService) that emit delegation.*_request events serviced here
    // (bridgeDelegation), so edits/commands run in the editor — surfacing as reviewable diffs.
    const delegate = fsCap || termCap ? { fs: fsCap, terminal: termCap } : undefined;
    try {
      await this.handlers.session.configureRuntime({ id: sid, sandboxRoots, mcpServers: mcpSpecs, delegate });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('(404)')) throw err;
    }
  }

  /** session/list → monad's session.list. cwd is the adapter's tracked value for sessions opened
   * this connection, else '' (monad sessions don't persist a cwd). */
  async listSessions(_params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const { sessions } = await this.handlers.session.list({});
    return {
      sessions: sessions.map((s) => ({
        sessionId: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        cwd: this.sessions.get(s.id as SessionId)?.cwd ?? ''
      }))
    };
  }

  /** session/load → re-attach an existing session and replay its transcript as session/update
   * notifications, so an editor that reopens a session sees the prior conversation. */
  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const sid = params.sessionId as SessionId;
    await this.registerSession(sid, params.cwd, params.mcpServers);
    const { messages } = await this.handlers.session.messages({ id: sid });
    for (const m of messages) {
      if (m.role !== 'user' && m.role !== 'assistant') continue; // skip system/tool rows
      const sessionUpdate = m.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk';
      await this.conn.client.notify('session/update', {
        sessionId: sid,
        update: { sessionUpdate, content: { type: 'text', text: m.text } }
      });
    }
    void this.sendAvailableCommands(sid);
    void this.sendSessionInfo(sid);
    return {};
  }

  /** **UNSTABLE** session/resume → re-attach an existing session WITHOUT replaying history (unlike
   * session/load), for clients that kept their own transcript. */
  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const sid = params.sessionId as SessionId;
    await this.registerSession(sid, params.cwd, params.mcpServers, params.additionalDirectories);
    void this.sendAvailableCommands(sid);
    void this.sendSessionInfo(sid);
    return {};
  }

  /** Push the session's current title to the client as a session_info_update, so the editor's
   * session view reflects monad's title (which the NewSessionResponse can't carry). */
  private async sendSessionInfo(sid: SessionId): Promise<void> {
    try {
      const { session } = await this.handlers.session.get({ id: sid });
      await this.conn.client.notify('session/update', {
        sessionId: sid,
        update: { sessionUpdate: 'session_info_update', title: session.title, updatedAt: session.updatedAt }
      });
    } catch {
      // Non-fatal — info is a convenience.
    }
  }

  /** Advertise monad's unified command set (host built-ins + atom pack commands + user-invocable
   * skills) to the client as ACP commands, so the editor shows them in its `/`-command menu. Host
   * commands run in the daemon (no LLM turn); skills expand via the loop's resolveExplicitSkill —
   * both are triggered by sending `/name args` as a normal prompt. */
  private async sendAvailableCommands(sid: SessionId): Promise<void> {
    try {
      const { commands } = await this.handlers.commands.list();
      const availableCommands = commands
        .filter((c) => c.enabled)
        .map((c) => ({ name: c.id, description: c.description, input: { hint: c.argHint ?? 'arguments' } }));
      if (availableCommands.length > 0) {
        await this.conn.client.notify('session/update', {
          sessionId: sid,
          update: { sessionUpdate: 'available_commands_update', availableCommands }
        });
      }
    } catch {
      // Non-fatal: commands are a convenience, not required for the session to work.
    }
  }

  /** session/delete → permanent removal via monad's session.delete (which also releases the
   * session's daemon-side runtime: MCP connections + sandbox config). */
  async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    const sid = params.sessionId as SessionId;
    await this.handlers.session.delete({ id: sid });
    this.sessions.delete(sid);
    return {};
  }

  /** session/close → cancel ongoing work and drop adapter state, but keep the session in monad (it
   * can be reopened with session/load). Release the daemon-side runtime (closes session MCP, clears
   * sandbox roots) by reconfiguring it empty — a later session/load re-pushes the client's config. */
  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const sid = params.sessionId as SessionId;
    await this.handlers.session.abort({ id: sid });
    await this.handlers.session.configureRuntime({ id: sid }).catch(() => {});
    this.sessions.delete(sid);
    return {};
  }

  // ── Document sync: the editor tells us which files are open/changed/focused; we track them per
  // session and feed them to the model as ambient context each turn (see renderOpenDocs). ──

  async unstable_didOpenDocument(p: DidOpenDocumentNotification): Promise<void> {
    this.sessions
      .get(p.sessionId as SessionId)
      ?.openDocs.set(p.uri, { text: p.text, version: p.version, languageId: p.languageId });
  }

  async unstable_didChangeDocument(p: DidChangeDocumentNotification): Promise<void> {
    const doc = this.sessions.get(p.sessionId as SessionId)?.openDocs.get(p.uri);
    if (!doc) return;
    for (const change of p.contentChanges) {
      doc.text = change.range ? applyRangeEdit(doc.text, change.range, change.text) : change.text;
    }
    doc.version = p.version;
  }

  async unstable_didCloseDocument(p: DidCloseDocumentNotification): Promise<void> {
    const session = this.sessions.get(p.sessionId as SessionId);
    session?.openDocs.delete(p.uri);
    if (session?.focusedUri === p.uri) session.focusedUri = undefined;
  }

  async unstable_didFocusDocument(p: DidFocusDocumentNotification): Promise<void> {
    const session = this.sessions.get(p.sessionId as SessionId);
    if (session) session.focusedUri = p.uri;
  }

  async unstable_didSaveDocument(_p: DidSaveDocumentNotification): Promise<void> {
    // No-op: we already track live content via didChange; save carries no new content.
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const t0 = performance.now();
    const sessionId = params.sessionId as SessionId;
    const text = promptToText(params.prompt);
    const attachments = promptToAttachments(params.prompt);
    const session = this.sessions.get(sessionId);
    if (session) session.cancelled = false;

    let finishReason: FinishReason | undefined;
    let agentError: AgentErrorPayload | undefined;
    const sink = (event: Event) => {
      if (event.type === 'tool.approval_requested') {
        void bridgePermission(this.conn, this.handlers, sessionId, event);
        return;
      }
      if (event.type === 'clarify.requested') {
        void bridgeClarify(this.conn, this.handlers, this.clientCaps, sessionId, event);
        return;
      }
      if (event.type === 'delegation.fs_request' || event.type === 'delegation.terminal_request') {
        void bridgeDelegation(this.handlers, this.sessions.get(sessionId)?.backends, event);
        return;
      }
      if (event.type === 'agent.error') {
        // Surface the failure in the transcript AND remember it so the turn ends as an error,
        // not a silent end_turn, even when the loop unwinds without throwing.
        agentError = parseEventPayload('agent.error', event.payload);
        void this.conn.client.notify('session/update', {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n⚠ ${agentError.message}` } }
        });
        return;
      }
      if (event.type === 'agent.message') {
        finishReason = parseEventPayload('agent.message', event.payload).finishReason;
      }
      const update = eventToSessionUpdate(event);
      // Notifications are queued in emit order by the connection; fire-and-forget preserves it.
      if (update) void this.conn.client.notify('session/update', { sessionId, update });
      // A todo_write result also surfaces as a `plan` checklist (in addition to its tool update).
      const plan = eventToPlanUpdate(event);
      if (plan) void this.conn.client.notify('session/update', { sessionId, update: plan });
    };

    try {
      await this.handlers.session.sendInline({ sessionId, text }, sink, {
        transport: 'acp',
        backends: session?.backends,
        toolFilter: session?.toolFilter,
        attachments: attachments.length ? attachments : undefined,
        ambientContext: session ? renderOpenDocs(session.openDocs, session.focusedUri) : undefined
        // sandboxRoots + session MCP tools (extraTools) are configured out-of-band via
        // configureRuntime (registerSession), so they apply on every turn — including over the
        // bridge, where runOpts can't cross the wire.
      });
    } catch (err) {
      // An abort (session/cancel) may surface as a thrown AbortError from runStream.
      if (session?.cancelled || isAbort(err)) {
        logAcpCall('prompt', {
          sessionId,
          stopReason: 'cancelled',
          durationMs: Math.round(performance.now() - t0)
        });
        return { stopReason: 'cancelled' };
      }
      throw err;
    }
    // A cancel can also let the run unwind cleanly; the flag is the source of truth.
    if (session?.cancelled) {
      logAcpCall('prompt', {
        sessionId,
        stopReason: 'cancelled',
        durationMs: Math.round(performance.now() - t0)
      });
      return { stopReason: 'cancelled' };
    }
    // A model/gateway error that didn't throw still ends the turn as an error for the client.
    if (agentError) {
      logAcpCall('prompt', { sessionId, err: agentError.code ?? 'error' });
      throw RequestError.internalError(undefined, agentError.message);
    }
    const stopReason = finishReasonToStopReason(finishReason);
    logAcpCall('prompt', { sessionId, stopReason, durationMs: Math.round(performance.now() - t0) });
    return { stopReason };
  }

  async cancel(params: CancelNotification): Promise<void> {
    const t0 = performance.now();
    const sessionId = params.sessionId as SessionId;
    const session = this.sessions.get(sessionId);
    if (session) session.cancelled = true;
    await this.handlers.session.abort({ id: sessionId });
    logAcpCall('cancel', { sessionId, durationMs: Math.round(performance.now() - t0) });
  }

  /** monad-specific extension methods over ACP's `_meta`/ext channel. Restore has no ACP
   * equivalent; model gateway lets a client pick a profile through monad. Credential mutation
   * is intentionally NOT exposed here — it stays on the trusted native/TUI path. */
  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sid = params.sessionId as SessionId;
    switch (method) {
      case '_monad/session.restore':
        return { ...(await this.handlers.session.restore({ id: sid, toMessageId: params.toMessageId as MessageId })) };
      case '_monad/model.listProviders':
        return { ...(await this.handlers.model.listProviders()) };
      case '_monad/model.listModels':
        return { ...(await this.handlers.model.listModels({ providerId: params.providerId as string })) };
      case '_monad/model.listProfiles':
        return { ...(await this.handlers.model.listProfiles()) };
      case '_monad/model.getDefaultProfile':
        return { ...(await this.handlers.model.getDefaultProfile()) };
      case '_monad/model.setDefaultProfile':
        return { ...(await this.handlers.model.setDefaultProfile({ alias: params.alias as string })) };
      default:
        throw RequestError.methodNotFound(method);
    }
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.message.toLowerCase().includes('abort'));
}
