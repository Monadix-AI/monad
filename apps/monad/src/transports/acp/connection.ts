// ACP transport — monad as an Agent Client Protocol agent over stdio.
//
// Unlike the native stdio dialect (transports/stdio.ts), ACP is a *bidirectional* JSON-RPC
// peer: the agent issues requests back to the client (permission, fs, terminal). We lean on
// the official SDK's agent() builder for the peer + id-correlation, and reuse the daemon's
// existing `handlers` + event flow — this file is a pure protocol adapter, no business logic.
//
// stdout is exclusively the ACP channel; all logs MUST go to stderr.

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
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  Stream
} from '@agentclientprotocol/sdk';
import type {
  AgentErrorPayload,
  AgentId,
  ApprovalScope,
  Event,
  FinishReason,
  MessageId,
  SessionId,
  SessionOriginExt
} from '@monad/protocol';
import type { McpServerSpec } from '@/capabilities/tools';
import type { ToolBackends } from '@/capabilities/tools/types.ts';
import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import { agent as createAcpAgent, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import { createLogger, formatTransportCall } from '@monad/logger';
import { parseEventPayload, sessionOriginExtSchema } from '@monad/protocol';

import { createSandboxBackends, isDelegableTool } from '@/capabilities/tools';
import { VERSION } from '@/handlers/handlers.ts';
import { buildSessionOrigin, hostOs } from '@/handlers/session/origin.ts';
import { createAcpFsBackend, createAcpTerminalBackend } from '@/transports/acp/backends.ts';
import { applyRangeEdit, type OpenDoc, renderOpenDocs } from '@/transports/acp/documents.ts';
import {
  eventToPlanUpdate,
  eventToSessionUpdate,
  finishReasonToStopReason,
  promptToAttachments,
  promptToText,
  toolKind
} from '@/transports/acp/translate.ts';

const log = createLogger('transport:acp');

type DaemonHandlers = ReturnType<typeof createDaemonHandlers>;

function logAcpCall(method: string, fields: Record<string, unknown> = {}): void {
  const record = { method, ...fields };
  log.trace(record, formatTransportCall(record));
}

/** The exact handler surface the ACP adapter touches. Derived (not redeclared) from the real
 * daemon handlers so it stays a single source of truth — yet narrow enough that an out-of-process
 * RPC **proxy** (transports/acp/bridge.ts) can satisfy it without reimplementing the whole daemon.
 * Both the in-process handlers and the bridge proxy are assignable to this. */
export type AcpHandlers = {
  session: Pick<
    DaemonHandlers['session'],
    | 'create'
    | 'get'
    | 'branch'
    | 'list'
    | 'messages'
    | 'delete'
    | 'abort'
    | 'sendInline'
    | 'restore'
    | 'provenance'
    | 'configureRuntime'
  >;
  commands: Pick<DaemonHandlers['commands'], 'list'>;
  oversight: Pick<DaemonHandlers['oversight'], 'approve'>;
  clarify: Pick<DaemonHandlers['clarify'], 'respond'>;
  delegation: Pick<DaemonHandlers['delegation'], 'respond' | 'output'>;
  model: Pick<
    DaemonHandlers['model'],
    'listProviders' | 'listModels' | 'listProfiles' | 'getDefaultProfile' | 'setDefaultProfile'
  >;
};

type Handlers = AcpHandlers;

/** Per-session state the adapter tracks for the lifetime of one ACP connection. */
interface AcpSession {
  /** Working directory from `session/new`; absolute per spec. */
  cwd: string;
  /** Set by `session/cancel` for the in-flight turn so `prompt` reports StopReason::Cancelled. */
  cancelled: boolean;
  /** Delegating fs/terminal backends when the client advertises the capability; absent → the
   * loop's default sandbox backend over the daemon disk. */
  backends?: ToolBackends;
  /** Drops daemon-host tools when this session delegates execution. */
  toolFilter?: (toolName: string) => boolean;
  /** Documents the editor has open in this session (uri → state), synced via `unstable_did*Document`
   * notifications and surfaced to the model as ambient context each turn. */
  openDocs: Map<string, OpenDoc>;
  /** The uri the editor most recently focused (rendered first / marked active in the context). */
  focusedUri?: string;
  /** Sandbox roots for this session = the client's cwd + additionalDirectories. ACP trusts the
   * client (it's user-controlled), so these REPLACE the daemon's roots for this session's fs/shell
   * (non-delegated paths); for delegated fs the editor owns the filesystem anyway. */
  sandboxRoots: string[];
}

class MonadAcpAgent {
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
        .filter((c) => c.available)
        .map((c) => ({ name: c.name, description: c.description, input: { hint: c.argHint ?? 'arguments' } }));
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
        void this.bridgePermission(sessionId, event);
        return;
      }
      if (event.type === 'clarify.requested') {
        void this.bridgeClarify(sessionId, event);
        return;
      }
      if (event.type === 'delegation.fs_request' || event.type === 'delegation.terminal_request') {
        void this.bridgeDelegation(sessionId, event);
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

  /** Service a daemon delegation request against the editor: the daemon's remote fs/terminal backend
   * emitted a `delegation.{fs,terminal}_request` event (routed here over the turn's stream); we run it
   * via this session's editor-facing backends (createAcp*Backend) and answer through delegation.respond
   * (streaming terminal output via delegation.output). The reverse of services/delegation.ts. */
  private async bridgeDelegation(sessionId: SessionId, event: Event): Promise<void> {
    const p = event.payload as {
      requestId: string;
      op?: 'read' | 'write';
      path?: string;
      offset?: number;
      limit?: number;
      content?: string;
      command?: string;
      cwd?: string;
      timeoutMs?: number;
    };
    const backends = this.sessions.get(sessionId)?.backends;
    if (!backends) {
      await this.handlers.delegation.respond({ requestId: p.requestId, ok: false, error: 'no delegated backend' });
      return;
    }
    try {
      if (event.type === 'delegation.fs_request') {
        if (p.op === 'write') {
          const result = await backends.fs.writeTextFile(p.path ?? '', p.content ?? '');
          await this.handlers.delegation.respond({ requestId: p.requestId, ok: true, result });
        } else {
          const content = await backends.fs.readTextFile(p.path ?? '', { offset: p.offset, limit: p.limit });
          await this.handlers.delegation.respond({ requestId: p.requestId, ok: true, result: { content } });
        }
      } else {
        const result = await backends.terminal.exec({
          command: p.command ?? '',
          cwd: p.cwd,
          timeoutMs: p.timeoutMs,
          onChunk: (output) => void this.handlers.delegation.output({ requestId: p.requestId, output })
        });
        await this.handlers.delegation.respond({ requestId: p.requestId, ok: true, result });
      }
    } catch (err) {
      await this.handlers.delegation.respond({
        requestId: p.requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  /** Bridge a monad oversight gate request to the client's `session/request_permission`
   * reverse-RPC, then feed the user's decision back into the gate via `oversight.approve`. */
  private async bridgePermission(sessionId: SessionId, event: Event): Promise<void> {
    const { requestId, tool, input } = event.payload as { requestId: string; tool: string; input: unknown };
    const req: RequestPermissionRequest = {
      sessionId,
      toolCall: { toolCallId: requestId, title: tool, kind: toolKind(tool), status: 'pending', rawInput: input },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'allow_session', name: 'Allow for this session', kind: 'allow_always' },
        { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        { optionId: 'reject_always', name: 'Always reject', kind: 'reject_once' }
      ]
    };
    try {
      const { outcome } = (await this.conn.client.request(
        'session/request_permission',
        req
      )) as RequestPermissionResponse;
      if (outcome.outcome === 'cancelled') {
        // Cancellation never persists — single-call deny only.
        await this.handlers.oversight.approve({ requestId, allow: false, reason: 'cancelled', scope: 'once' });
        return;
      }
      // Map each editor option to a (allow, scope) pair. 'allow_always'/'reject_always' persist
      // globally; 'allow_session' persists for the session; the rest resolve a single call.
      const id = outcome.optionId;
      const allow = id === 'allow' || id === 'allow_session' || id === 'allow_always';
      const scope: ApprovalScope =
        id === 'allow_always' || id === 'reject_always' ? 'global' : id === 'allow_session' ? 'session' : 'once';
      await this.handlers.oversight.approve({
        requestId,
        allow,
        reason: allow ? undefined : 'rejected in editor',
        scope
      });
    } catch {
      // Connection error / client failure → fail closed so the gate doesn't hang.
      await this.handlers.oversight.approve({
        requestId,
        allow: false,
        reason: 'permission request failed',
        scope: 'once'
      });
    }
  }

  /** Bridge a monad `clarify_ask` question to the client. A multiple-choice question maps to
   * `session/request_permission` (each choice an option). A free-text question uses form
   * elicitation when the client supports it (real input box); otherwise it degrades to surfacing
   * the question and letting the agent proceed (the user answers in the next prompt turn). */
  private async bridgeClarify(sessionId: SessionId, event: Event): Promise<void> {
    const { requestId, question, options } = event.payload as {
      requestId: string;
      question: string;
      options?: string[];
    };
    if (!options || options.length === 0) {
      await this.bridgeFreeTextClarify(sessionId, requestId, question);
      return;
    }
    try {
      const { outcome } = (await this.conn.client.request('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: requestId, title: question, kind: 'think', status: 'pending' },
        options: options.map((name, i) => ({ optionId: String(i), name, kind: 'allow_once' as const }))
      })) as RequestPermissionResponse;
      const answer = outcome.outcome === 'selected' ? (options[Number(outcome.optionId)] ?? '') : '';
      await this.handlers.clarify.respond({ requestId, answer });
    } catch {
      await this.handlers.clarify.respond({ requestId, answer: '' });
    }
  }

  private async bridgeFreeTextClarify(sessionId: SessionId, requestId: string, question: string): Promise<void> {
    // No form-elicitation support → surface the question and let the agent proceed.
    if (!this.clientCaps.elicitation?.form) {
      void this.conn.client.notify('session/update', {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n[clarify] ${question}\n` } }
      });
      await this.handlers.clarify.respond({ requestId, answer: '' });
      return;
    }
    try {
      const res = await this.conn.client.request('elicitation/create', {
        mode: 'form',
        sessionId,
        message: question,
        requestedSchema: {
          type: 'object',
          properties: { answer: { type: 'string', title: 'Answer' } },
          required: ['answer']
        }
      });
      const answer = res.action === 'accept' ? String(res.content?.answer ?? '') : '';
      await this.handlers.clarify.respond({ requestId, answer });
    } catch {
      await this.handlers.clarify.respond({ requestId, answer: '' });
    }
  }

  /** monad-specific extension methods over ACP's `_meta`/ext channel. Restore + provenance have no
   * ACP equivalent; model gateway lets a client pick a profile through monad. Credential mutation
   * is intentionally NOT exposed here — it stays on the trusted native/TUI path. */
  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sid = params.sessionId as SessionId;
    switch (method) {
      case '_monad/session.restore':
        return { ...(await this.handlers.session.restore({ id: sid, toMessageId: params.toMessageId as MessageId })) };
      case '_monad/session.provenance':
        return { ...(await this.handlers.session.provenance({ id: sid })) };
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

/** Extension methods advertised in `initialize` under `_meta.monad.extMethods`. */
const MONAD_EXT_METHODS = [
  '_monad/session.restore',
  '_monad/session.provenance',
  '_monad/model.listProviders',
  '_monad/model.listModels',
  '_monad/model.listProfiles',
  '_monad/model.getDefaultProfile',
  '_monad/model.setDefaultProfile'
] as const;

/** Map an ACP MCP server descriptor to monad's connect spec. Returns null for transports monad's
 * MCP client doesn't speak (sse, acp). Structural checks tolerate tag-shape variations across SDK
 * versions (stdio carries `command`; http carries a `url`). */
export function toMcpSpec(server: McpServer): McpServerSpec | null {
  if ('command' in server) {
    return {
      name: server.name,
      command: server.command,
      args: server.args,
      env: Object.fromEntries((server.env ?? []).map((e) => [e.name, e.value]))
    };
  }
  if ('type' in server && server.type === 'http' && 'url' in server) {
    return {
      name: server.name,
      transport: 'http',
      url: server.url,
      headers: Object.fromEntries((server.headers ?? []).map((h) => [h.name, h.value]))
    };
  }
  return null;
}

/** Read monad's namespaced metadata bag off any ACP `_meta` field. */
function monadMeta(meta: unknown): { agentId?: string; ext?: unknown } | undefined {
  if (meta && typeof meta === 'object' && 'monad' in meta) {
    return (meta as { monad?: { agentId?: string; ext?: unknown } }).monad;
  }
  return undefined;
}

/** Validate a client-supplied `_meta.monad.ext` bag (untrusted, bounded) for the session origin. */
function acpExt(meta: unknown): SessionOriginExt | undefined {
  const raw = monadMeta(meta)?.ext;
  if (raw === undefined) return undefined;
  const parsed = sessionOriginExtSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.message.toLowerCase().includes('abort'));
}

/** Bind monad's handlers to an ACP peer over an arbitrary message stream. Returns the live
 * connection. Used by {@link startAcpTransport} for stdio and by tests over an in-memory pipe.
 * `sandboxRoots` is the fallback boundary for sessions whose client can't take fs/terminal. */
export function connectAcp(handlers: Handlers, stream: Stream, sandboxRoots?: string[]): AgentConnection {
  // Each call to connectAcp creates a fresh MonadAcpAgent (via onConnect) that owns per-connection
  // state (sessions map, clientCaps, etc.). The closure variable `inst` is unique per call, so
  // multiple simultaneous connections (or sequential test runs) don't share state.
  let inst!: MonadAcpAgent;
  const asParams = (p: unknown) => p as Record<string, unknown>;
  return createAcpAgent({ name: 'monad' })
    .onConnect((conn) => {
      inst = new MonadAcpAgent(conn, handlers, sandboxRoots);
    })
    .onRequest('initialize', ({ params }) => inst.initialize(params))
    .onRequest('authenticate', ({ params }) => inst.authenticate(params))
    .onRequest('session/new', ({ params }) => inst.newSession(params))
    .onRequest('session/fork', ({ params }) => inst.unstable_forkSession(params))
    .onRequest('session/load', ({ params }) => inst.loadSession(params))
    .onRequest('session/resume', ({ params }) => inst.resumeSession(params))
    .onRequest('session/list', ({ params }) => inst.listSessions(params))
    .onRequest('session/delete', ({ params }) => inst.deleteSession(params))
    .onRequest('session/close', ({ params }) => inst.closeSession(params))
    .onRequest('session/prompt', ({ params }) => inst.prompt(params))
    .onNotification('session/cancel', ({ params }) => inst.cancel(params))
    .onNotification('document/didOpen', ({ params }) => inst.unstable_didOpenDocument(params))
    .onNotification('document/didChange', ({ params }) => inst.unstable_didChangeDocument(params))
    .onNotification('document/didClose', ({ params }) => inst.unstable_didCloseDocument(params))
    .onNotification('document/didFocus', ({ params }) => inst.unstable_didFocusDocument(params))
    .onNotification('document/didSave', ({ params }) => inst.unstable_didSaveDocument(params))
    .onRequest('_monad/session.restore', asParams, ({ params }) => inst.extMethod('_monad/session.restore', params))
    .onRequest('_monad/session.provenance', asParams, ({ params }) =>
      inst.extMethod('_monad/session.provenance', params)
    )
    .onRequest('_monad/model.listProviders', asParams, ({ params }) =>
      inst.extMethod('_monad/model.listProviders', params)
    )
    .onRequest('_monad/model.listModels', asParams, ({ params }) => inst.extMethod('_monad/model.listModels', params))
    .onRequest('_monad/model.listProfiles', asParams, ({ params }) =>
      inst.extMethod('_monad/model.listProfiles', params)
    )
    .onRequest('_monad/model.getDefaultProfile', asParams, ({ params }) =>
      inst.extMethod('_monad/model.getDefaultProfile', params)
    )
    .onRequest('_monad/model.setDefaultProfile', asParams, ({ params }) =>
      inst.extMethod('_monad/model.setDefaultProfile', params)
    )
    .connect(stream);
}

/** Start the ACP transport on stdio. Resolves when the client disconnects (stdin EOF). */
export async function startAcpTransport(handlers: Handlers, sandboxRoots?: string[]): Promise<void> {
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        process.stdout.write(chunk, (err) => (err ? reject(err) : resolve()));
      });
    }
  });
  const stream = ndJsonStream(output, Bun.stdin.stream());
  const conn = connectAcp(handlers, stream, sandboxRoots);
  await conn.closed;
}
