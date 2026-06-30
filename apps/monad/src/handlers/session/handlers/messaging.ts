import type { AcpAgentConfig, McpServerConfig, NativeCliAgentConfig } from '@monad/home';
import type {
  ChannelResponseNextTarget,
  ChatMessage,
  Event,
  SendMessageRequest,
  Session,
  SessionId,
  SessionMcpServer,
  SessionTransport,
  SessionUiEvent
} from '@monad/protocol';
import type { ImageAttachment } from '@/agent/index.ts';
import type { Tool, ToolBackends } from '@/capabilities/tools/types.ts';
import type { CommandBundle, LifecycleOps } from '@/handlers/commands/index.ts';
import type { EventSink, SessionContext } from '@/handlers/session/context.ts';

import { loadAll } from '@monad/home';
import { newId, parseChannelStructuredResponse } from '@monad/protocol';

import { parseDurableSummary } from '@/agent/history.ts';
import { extractError } from '@/agent/index.ts';
import { buildChannelTurnContext, type ChannelParticipant, composeAcpChannelPrompt } from '@/agent/prompts/channel.ts';
import { emitCommandTurn, executeSessionCommand, tryRunSessionCommand } from '@/handlers/commands/index.ts';
import { HandlerError } from '@/handlers/handler-error.ts';
import {
  CHANNEL_HOST_EXT_KEY,
  normalizeChannelModeratorId,
  routeChannelMessage
} from '@/handlers/session/channel-routing.ts';
import { SessionUiProjector } from '@/handlers/session/ui-projection.ts';
import {
  acpAuthGuidance,
  directDelegate,
  sessionMcpServersToAcp,
  toAcpMcpServers
} from '@/services/delegation/acp-delegate.ts';

// Access control reads the write policy STORED on the session (origin.writableBy) — derived from the
// originating surface at creation, overridable per-session — not a label→transport lookup at the call
// site. Sessions with no origin stay unrestricted.
function assertWriteAllowed(session: Session, transport: SessionTransport): void {
  const writableBy = session.origin?.writableBy;
  if (!writableBy) return;
  if (!writableBy.includes(transport)) {
    throw new HandlerError('forbidden', `transport '${transport}' cannot write to this session`);
  }
}

/** Slash-command wiring, supplied by the session module once the lifecycle handlers exist. */
export interface MessagingCommandDeps {
  lifecycle: LifecycleOps;
  commands: CommandBundle;
}

type ToolFilter = (toolName: string) => boolean;
const CONTROL_ROOM_SESSION_PREFIX = 'Control Room: ';
const WORKPLACE_SESSION_PREFIX = 'Workplace: ';

// Size of the live UI snapshot window. Older history is paged lazily over GET /ui-items.
// Keep ≥ a realistic single agent round so a tool call+result pair never straddles the window.
const LIVE_SNAPSHOT_LIMIT = 80;

/** AND two optional tool filters: a tool passes only if every present filter admits it. Undefined-safe;
 *  returns undefined when neither is set so the loop keeps its no-filter fast path. */
function composeFilter(a?: ToolFilter, b?: ToolFilter): ToolFilter | undefined {
  if (!a) return b;
  if (!b) return a;
  return (name) => a(name) && b(name);
}

function lastAgentMessageText(round: Event[]): string | null {
  for (let i = round.length - 1; i >= 0; i -= 1) {
    const event = round[i];
    if (event?.type !== 'agent.message') continue;
    const text = (event.payload as { text?: unknown }).text;
    return typeof text === 'string' ? text : null;
  }
  return null;
}

export function isChannelStructuredSession(session: Pick<Session, 'origin' | 'title'>): boolean {
  return (
    session.origin?.client === 'control-room' ||
    session.origin?.client === 'workplace' ||
    session.title.startsWith(CONTROL_ROOM_SESSION_PREFIX) ||
    session.title.startsWith(WORKPLACE_SESSION_PREFIX)
  );
}

export function channelDelegateMcpServers(
  configured: readonly McpServerConfig[] | undefined,
  sessionScoped: readonly SessionMcpServer[] | undefined
) {
  return [...toAcpMcpServers([...(configured ?? [])]), ...sessionMcpServersToAcp([...(sessionScoped ?? [])])];
}

export function createMessagingHandlers(ctx: SessionContext, cmd?: MessagingCommandDeps) {
  const {
    deps: { agent, bus, cache, store, ownerPrincipalId, sessionSandbox, agentToolFilter, agentSandboxRoots, log },
    aborts,
    runtime,
    beginRun,
    makeEmit,
    persistAndRetire,
    requireSession
  } = ctx;

  // Effective fs/shell sandbox roots for a turn, single precedence chain so every call site agrees:
  // an explicit per-turn override (the editor's workspace) > the per-session runtime entry (set by
  // applyWorkspaceRuntime on /workdir, create, update) > the persisted session.cwd (source of truth,
  // so a working folder survives a daemon restart that left the in-memory runtime map empty) > the
  // bound agent's per-agent override. A site that also has an async ephemeral fallback applies it to
  // this result (`?? await …`).
  const sandboxRootsFor = (
    sessionId: SessionId,
    cwd: string | undefined,
    rt: { sandboxRoots?: string[] } | undefined,
    override?: string[]
  ) => override ?? rt?.sandboxRoots ?? (cwd ? [cwd] : agentSandboxRoots?.(sessionId));

  const runner = cmd ? { store, bus, lifecycle: cmd.lifecycle, commands: cmd.commands, ownerPrincipalId } : null;

  function startAcpAssignedTask({
    sessionId,
    spec,
    text,
    ambientContext,
    mcpServers
  }: {
    sessionId: SessionId;
    spec: AcpAgentConfig;
    text: string;
    ambientContext?: string;
    mcpServers?: Parameters<typeof directDelegate>[2]['mcpServers'];
  }): void {
    log?.debug({ sessionId, event: 'channel.next.dispatch', agent: spec.name, text }, 'channel next dispatch');
    const round: Event[] = [];
    const emit = makeEmit(round);
    const controller = new AbortController();
    const agentMsgId = newId('msg');
    const acpToolCallId = newId('tc');
    let tokenIndex = 0;
    let acpProcessOutput = '';
    let acpResponseOutput = '';

    const emitAcpActivityProgress = () => {
      const sections = [
        acpProcessOutput.trim(),
        acpResponseOutput ? `response stream:\n${acpResponseOutput}` : ''
      ].filter(Boolean);
      emit({
        id: newId('evt'),
        sessionId,
        type: 'tool.progress',
        actorAgentId: null,
        payload: {
          toolCallId: acpToolCallId,
          tool: `acp:${spec.name}`,
          output: sections.join('\n\n') || 'waiting for response...'
        },
        at: new Date().toISOString()
      });
    };

    emit({
      id: newId('evt'),
      sessionId,
      type: 'tool.called',
      actorAgentId: null,
      payload: { toolCallId: acpToolCallId, tool: `acp:${spec.name}`, input: { agent: spec.name } },
      at: new Date().toISOString()
    });
    emitAcpActivityProgress();

    const rt = runtime.get(sessionId);
    directDelegate(spec, composeAcpChannelPrompt(text, ambientContext), {
      sessionId,
      signal: controller.signal,
      sandboxRoots: sandboxRootsFor(sessionId, requireSession(sessionId).cwd, rt),
      backends: rt?.backends,
      toolFilter: rt?.toolFilter,
      extraTools: rt?.extraTools,
      extraSkills: rt?.extraSkills,
      mcpServers,
      onChunk: (delta) => {
        emit({
          id: newId('evt'),
          sessionId,
          type: 'agent.token',
          actorAgentId: null,
          payload: { messageId: agentMsgId, agentName: spec.name, delta, index: tokenIndex++ },
          at: new Date().toISOString()
        });
        acpResponseOutput += delta;
        emitAcpActivityProgress();
      },
      onActivity: (output) => {
        acpProcessOutput = output;
        emitAcpActivityProgress();
      }
    })
      .then((fullText) => {
        emit({
          id: newId('evt'),
          sessionId,
          type: 'tool.result',
          actorAgentId: null,
          payload: { toolCallId: acpToolCallId, tool: `acp:${spec.name}`, ok: true, result: 'completed' },
          at: new Date().toISOString()
        });
        store.insertMessage(agentMsgId, sessionId, fullText, new Date().toISOString(), 'assistant', {
          data: { agentName: spec.name }
        });
        emit({
          id: newId('evt'),
          sessionId,
          type: 'agent.message',
          actorAgentId: null,
          payload: { messageId: agentMsgId, agentName: spec.name, text: fullText },
          at: new Date().toISOString()
        });
        persistAndRetire(sessionId, round);
      })
      .catch((err: unknown) => {
        const { code, message } = extractError(err);
        emit({
          id: newId('evt'),
          sessionId,
          type: 'tool.result',
          actorAgentId: null,
          payload: { toolCallId: acpToolCallId, tool: `acp:${spec.name}`, ok: false, result: message },
          at: new Date().toISOString()
        });
        store.insertMessage(
          agentMsgId,
          sessionId,
          code ? `[${code}] ${message}` : message,
          new Date().toISOString(),
          'assistant',
          { type: 'error', data: { agentName: spec.name } }
        );
        emit({
          id: newId('evt'),
          sessionId,
          type: 'agent.error',
          actorAgentId: null,
          payload: { messageId: agentMsgId, agentName: spec.name, code, message },
          at: new Date().toISOString()
        });
        persistAndRetire(sessionId, round);
      });
  }

  async function dispatchChannelNextTargets({
    sessionId,
    responseText,
    ambientContext,
    acpAgents,
    mcpServers
  }: {
    sessionId: SessionId;
    responseText: string;
    ambientContext: string;
    acpAgents: readonly AcpAgentConfig[];
    mcpServers?: Parameters<typeof directDelegate>[2]['mcpServers'];
  }): Promise<void> {
    const structured = parseChannelStructuredResponse(responseText);
    if (!structured?.next.length) return;
    const acpByName = new Map(acpAgents.map((agent) => [agent.name, agent]));
    for (const target of structured.next) {
      if (!target.agentId.startsWith('acp:')) continue;
      const agentName = target.agentId.slice(4);
      const spec = acpByName.get(agentName);
      if (!spec) continue;
      startAcpAssignedTask({
        sessionId,
        spec,
        text: channelNextPrompt(target),
        ambientContext,
        mcpServers
      });
    }
  }

  function channelNextPrompt(target: ChannelResponseNextTarget): string {
    return [
      target.title ? `Task: ${target.title}` : '',
      target.context ? `Context:\n${target.context}` : '',
      target.prompt
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  const handlers = {
    async send({
      sessionId,
      text,
      generate,
      ambientContext,
      onComplete
    }: { sessionId: SessionId; onComplete?: (text: string) => void | Promise<void> } & SendMessageRequest) {
      const session = requireSession(sessionId);
      assertWriteAllowed(session, 'http');
      log?.debug({ sessionId, event: 'session.send.accept', text, generate, ambientContext }, 'session send accept');
      // `busy` = a prior turn is still streaming for this session — the concurrency guard refuses a
      // command that would race it (the command check runs before beginRun, so aborts reflects prior).
      if (runner && (await tryRunSessionCommand(runner, session, text, { busy: aborts.has(sessionId) })))
        return { accepted: true as const };
      if (generate === false) {
        const messageId = newId('msg');
        const round: Event[] = [];
        store.insertMessage(messageId, sessionId, text, new Date().toISOString(), 'user');
        makeEmit(round)({
          id: newId('evt'),
          sessionId,
          type: 'user.message',
          actorAgentId: null,
          payload: { messageId, text },
          at: new Date().toISOString()
        });
        persistAndRetire(sessionId, round);
        log?.debug({ sessionId, event: 'session.send.recorded', messageId, text }, 'session send recorded');
        return { accepted: true as const };
      }
      const { round, signal } = beginRun(sessionId);
      const rt = runtime.get(sessionId);
      const loop = agent.loop(makeEmit(round), {
        modelOverride: session.model,
        ambientContext,
        sandboxRoots: sandboxRootsFor(sessionId, session.cwd, rt),
        defaultCwd: session.cwd,
        extraTools: rt?.extraTools,
        extraSkills: rt?.extraSkills,
        toolFilter: composeFilter(rt?.toolFilter, agentToolFilter?.(sessionId))
      });
      loop
        .runStream(sessionId, text, signal)
        .then(async () => {
          const finalText = lastAgentMessageText(round);
          persistAndRetire(sessionId, round);
          aborts.delete(sessionId);
          log?.debug({ sessionId, event: 'session.send.complete', finalText }, 'session send complete');
          if (finalText && onComplete) {
            try {
              await onComplete(finalText);
            } catch (err) {
              process.stderr.write(`channel next dispatch error (${sessionId}): ${err}\n`);
            }
          }
        })
        .catch((err: unknown) => {
          process.stderr.write(`runStream error (${sessionId}): ${err}\n`);
          log?.debug(
            {
              sessionId,
              event: 'session.send.error',
              err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err)
            },
            'session send error'
          );
          persistAndRetire(sessionId, round);
          aborts.delete(sessionId);
        });
      return { accepted: true as const };
    },

    async sendProjectMessage({ sessionId, text }: { sessionId: SessionId; text: string }) {
      const session = requireSession(sessionId);
      const paths = ctx.deps.paths;
      const cfg = paths ? await loadAll(paths.config, paths.profile) : null;
      const acpAgents = (cfg?.acpAgents ?? []).filter((agent: AcpAgentConfig) => agent.enabled !== false);
      const nativeCliAgents = (cfg?.nativeCliAgents ?? []).filter(
        (agent: NativeCliAgentConfig) => agent.enabled !== false
      );
      const moderatorAgentId = normalizeChannelModeratorId(session.origin?.ext?.[CHANNEL_HOST_EXT_KEY]);
      const route = routeChannelMessage({
        text,
        moderatorAgentId,
        acpAgentNames: acpAgents.map((agent: AcpAgentConfig) => agent.name),
        nativeCliAgentNames: nativeCliAgents.map((agent: NativeCliAgentConfig) => agent.name)
      });
      if (route.kind === 'none') return { accepted: true as const };
      const targetRole = moderatorAgentId && !route.direct ? 'moderator' : 'agent';
      log?.debug(
        {
          sessionId,
          projectSessionId: sessionId,
          event: 'project.message.route',
          text,
          moderatorAgentId,
          route,
          targetRole
        },
        'project message route'
      );
      const responseMode = moderatorAgentId
        ? targetRole === 'moderator'
          ? 'moderator_structured'
          : 'worker_plain'
        : route.direct
          ? 'direct_structured'
          : 'worker_plain';
      const studioAgents = cfg?.agent.agents ?? [];
      const studioHostName = moderatorAgentId?.startsWith('agent:')
        ? (studioAgents.find((agent) => `agent:${agent.id}` === moderatorAgentId)?.name ?? moderatorAgentId)
        : undefined;
      const participants: ChannelParticipant[] = [
        { id: 'human', name: 'User', kind: 'human' },
        ...studioAgents.map((agent) => ({
          id: `agent:${agent.id}`,
          name: agent.name,
          kind: 'studio' as const,
          description: agent.description
        })),
        ...acpAgents.map((agent: AcpAgentConfig) => ({
          id: `acp:${agent.name}`,
          name: agent.name,
          kind: 'acp' as const
        })),
        ...nativeCliAgents.map((agent: NativeCliAgentConfig) => ({
          id: `native-cli:${agent.name}`,
          name: agent.name,
          kind: 'native-cli' as const
        }))
      ];
      const ambientContext =
        route.kind === 'send' && route.generate === false
          ? undefined
          : buildChannelTurnContext({
              channelId: session.title,
              sessionId,
              routeKind: route.kind,
              targetName: route.kind === 'forward-acp' ? route.agentName : (studioHostName ?? 'monad'),
              targetRole,
              responseMode,
              moderatorAgentId,
              participants,
              targetMention: route.targetMention
            });
      const mcpServers = channelDelegateMcpServers(cfg?.mcpServers, runtime.get(sessionId)?.mcpServers);
      const dispatchStructuredNext =
        ambientContext && (responseMode === 'moderator_structured' || responseMode === 'direct_structured')
          ? (responseText: string) =>
              dispatchChannelNextTargets({ sessionId, responseText, ambientContext, acpAgents, mcpServers })
          : undefined;
      if (route.kind === 'send')
        return handlers.send({
          sessionId,
          text: route.text,
          generate: route.generate,
          ambientContext,
          onComplete: dispatchStructuredNext
        });
      if (route.kind === 'forward-native-cli')
        return handlers.forwardToNativeCli({
          sessionId,
          agentName: route.agentName,
          text: route.text,
          displayText: route.displayText
        });
      return handlers.forwardToAcp({
        sessionId,
        agentName: route.agentName,
        text: route.text,
        displayText: route.displayText,
        ambientContext,
        onComplete: dispatchStructuredNext
      });
    },

    async sendChannelMessage({ sessionId, text }: { sessionId: SessionId; text: string }) {
      return handlers.sendProjectMessage({ sessionId, text });
    },

    async sendInline(
      { sessionId, text }: { sessionId: SessionId } & SendMessageRequest,
      sink: EventSink,
      // ACP sessions pass a delegating backend (fs/shell run in the connected editor), a toolFilter
      // dropping tools that would otherwise run on the daemon host, and any image attachments for
      // the turn. Other transports omit these and the loop defaults to sandbox + text-only.
      runOpts?: {
        transport?: SessionTransport;
        backends?: ToolBackends;
        toolFilter?: (toolName: string) => boolean;
        attachments?: ImageAttachment[];
        ambientContext?: string;
        extraTools?: Tool[];
        sandboxRoots?: string[];
      }
    ) {
      const session = requireSession(sessionId);
      assertWriteAllowed(session, runOpts?.transport ?? 'acp');
      if (runner && (await tryRunSessionCommand(runner, session, text, { sink, busy: aborts.has(sessionId) }))) return;
      // Out-of-band per-session runtime config (sandbox roots / session-scoped MCP tools / delegating
      // backends) set via configureRuntime — used when the caller doesn't pass explicit runOpts (the
      // ACP bridge proxies turns over HTTP and can't ship in-process backends, so it configures the
      // daemon out-of-band).
      const rt = runtime.get(sessionId);
      // Shared precedence (runOpts override > rt > session.cwd > per-agent), then this session's
      // disposable ephemeral root (sandbox mode 'ephemeral'), then the loop's global default.
      const sandboxRoots =
        sandboxRootsFor(sessionId, session.cwd, rt, runOpts?.sandboxRoots) ?? (await sessionSandbox?.ensure(sessionId));
      const { round, signal } = beginRun(sessionId);
      const base = makeEmit(round);
      const loop = agent.loop(
        (event) => {
          base(event);
          sink(event);
        },
        {
          backends: runOpts?.backends ?? rt?.backends,
          toolFilter: composeFilter(runOpts?.toolFilter ?? rt?.toolFilter, agentToolFilter?.(sessionId)),
          ambientContext: runOpts?.ambientContext,
          extraTools: runOpts?.extraTools ?? rt?.extraTools,
          extraSkills: rt?.extraSkills,
          sandboxRoots,
          defaultCwd: session.cwd,
          modelOverride: session.model
        }
      );
      // Oversight (tool.approval_requested) and clarify (clarify.requested) are emitted by their
      // services straight to the bus, NOT through the loop's emit — so an inline consumer (ACP)
      // would never see them. Bridge those out-of-band events into the same sink for this turn.
      // Live-only (bus.subscribe doesn't replay) and filtered, so loop events aren't duplicated.
      const oob = bus.subscribe(sessionId, (event) => {
        switch (event.type) {
          case 'tool.approval_requested':
          case 'tool.approval_resolved':
          case 'clarify.requested':
          case 'clarify.resolved':
          case 'session.updated': // title/metadata changes → editors get a live session_info_update
          // Reverse fs/terminal delegation: the ACP bridge consumes these off the turn's stream and
          // services them against the editor, answering via the delegation.respond RPC.
          case 'delegation.fs_request':
          case 'delegation.terminal_request':
            sink(event);
        }
      });
      try {
        await loop.runStream(sessionId, text, signal, runOpts?.attachments);
      } finally {
        oob();
        persistAndRetire(sessionId, round);
        aborts.delete(sessionId);
      }
    },

    async generate({ sessionId, text }: { sessionId: SessionId } & SendMessageRequest) {
      const session = requireSession(sessionId);
      assertWriteAllowed(session, 'http');
      log?.debug({ sessionId, event: 'session.generate.start', text }, 'session generate start');
      if (runner) {
        const result = await executeSessionCommand(runner, session, text, { busy: aborts.has(sessionId) });
        if (result !== null) {
          const round: Event[] = [];
          const message = emitCommandTurn(store, makeEmit(round), sessionId, text, result);
          store.appendEvents(round);
          cache.retire(sessionId);
          return { message };
        }
      }
      const round: Event[] = [];
      const rt = runtime.get(sessionId);
      const loop = agent.loop(makeEmit(round), {
        modelOverride: session.model,
        sandboxRoots: sandboxRootsFor(sessionId, session.cwd, rt),
        defaultCwd: session.cwd,
        extraTools: rt?.extraTools,
        extraSkills: rt?.extraSkills,
        toolFilter: composeFilter(rt?.toolFilter, agentToolFilter?.(sessionId))
      });
      try {
        const msg = await loop.runBlock(sessionId, text);
        log?.debug({ sessionId, event: 'session.generate.complete', text: msg.text }, 'session generate complete');
        const message: ChatMessage = {
          id: msg.id as ChatMessage['id'],
          sessionId: msg.sessionId as ChatMessage['sessionId'],
          role: msg.role,
          text: msg.text,
          type: 'text',
          stream: { status: 'complete' },
          active: true,
          createdAt: msg.createdAt
        };
        return { message };
      } catch (err) {
        // The model/gateway failed upstream — the daemon itself is healthy, so 502
        // (Bad Gateway) is the accurate status, not 500. runBlock already persisted
        // and emitted the failure; surface the parsed message in the response body.
        const { code, message } = extractError(err);
        log?.debug({ sessionId, event: 'session.generate.error', code, message }, 'session generate error');
        throw new HandlerError('bad_gateway', code ? `[${code}] ${message}` : message);
      } finally {
        persistAndRetire(sessionId, round);
      }
    },

    async subscribe({ sessionId, afterEventId }: { sessionId: SessionId; afterEventId?: string }, sink: EventSink) {
      const buffered = await cache.since(sessionId, afterEventId);
      const replay = buffered.length > 0 ? buffered : store.listEvents(sessionId, afterEventId);
      for (const event of replay) sink(event);
      const dispose = bus.subscribe(sessionId, sink);
      return { subscribed: true as const, dispose };
    },

    async subscribeUi(
      { sessionId, afterEventId }: { sessionId: SessionId; afterEventId?: string },
      sink: (event: SessionUiEvent) => void
    ) {
      const session = requireSession(sessionId);
      const projector = new SessionUiProjector({ channelStructured: isChannelStructuredSession(session) });
      // Bound the initial snapshot to the most-recent window; older history is loaded lazily by
      // the client over GET /ui-items. A full window implies there may be older messages.
      const recent = store.listMessages(sessionId, {
        includeInactive: false,
        latest: true,
        limit: LIVE_SNAPSHOT_LIMIT
      });
      const hasMore = recent.length === LIVE_SNAPSHOT_LIMIT;
      projector.hydrateMessages(recent, parseDurableSummary(store.getMemory(sessionId, 'ctx:summary')));
      // Replay in-flight (un-persisted) round events on top of the hydrated window. On a fresh
      // subscribe, hydration already covers every persisted message, so we must NOT fall back to
      // the full event history — that would re-introduce older messages and scramble the bounded
      // snapshot. Only a reconnect (afterEventId set) needs the durable replay since its cursor.
      const buffered = await cache.since(sessionId, afterEventId);
      const replay =
        buffered.length > 0 ? buffered : afterEventId !== undefined ? store.listEvents(sessionId, afterEventId) : [];
      for (const event of replay) projector.applyEvent(event);
      sink(projector.snapshot({ hasMore }));
      const dispose = bus.subscribe(sessionId, (event) => {
        for (const uiEvent of projector.applyEvent(event)) sink(uiEvent);
      });
      return { subscribed: true as const, dispose };
    },

    /**
     * Subscribe to the cross-session control stream (session-list-level changes
     * across all sessions). No replay: a (re)connecting client should re-fetch the
     * list via `sessions.list`, then apply live deltas from here.
     */
    subscribeControl(sink: EventSink) {
      const dispose = bus.subscribeControl(sink);
      return { subscribed: true as const, dispose };
    },

    /** Send text directly to a configured ACP agent, bypassing the monad LLM layer.
     *  Emits user.message + streaming agent.token + final agent.message into the session event stream
     *  so the existing session subscriber sees the exchange without any monad turn overhead. */
    async forwardToAcp({
      sessionId,
      agentName,
      text,
      displayText,
      ambientContext,
      onComplete
    }: {
      sessionId: SessionId;
      agentName: string;
      text: string;
      displayText?: string;
      ambientContext?: string;
      onComplete?: (text: string) => void | Promise<void>;
    }) {
      const session = requireSession(sessionId);
      assertWriteAllowed(session, 'http');
      // Reject if a turn is already streaming for this session — same concurrency guard as `send`.
      if (aborts.has(sessionId)) throw new HandlerError('conflict', 'a turn is already in progress for this session');
      const paths = ctx.deps.paths;
      if (!paths) throw new HandlerError('internal', 'daemon paths not configured');
      const cfg = await loadAll(paths.config, paths.profile);
      const spec = (cfg?.acpAgents ?? []).find((a: AcpAgentConfig) => a.name === agentName && a.enabled !== false);
      if (!spec) throw new HandlerError('invalid', `ACP agent "${agentName}" not found or disabled`);
      log?.debug(
        { sessionId, event: 'session.forward_acp.start', agentName, text, ambientContext },
        'forward acp start'
      );

      const { round, signal } = beginRun(sessionId);
      const emit = makeEmit(round);
      const userMsgId = newId('msg');
      const agentMsgId = newId('msg');
      const acpToolCallId = newId('tc');
      let tokenIndex = 0;
      let acpActivityStarted = false;
      let acpProcessOutput = '';
      let acpResponseOutput = '';

      const emitAcpActivityStart = () => {
        if (acpActivityStarted) return;
        acpActivityStarted = true;
        emit({
          id: newId('evt'),
          sessionId,
          type: 'tool.called',
          actorAgentId: null,
          payload: { toolCallId: acpToolCallId, tool: `acp:${spec.name}`, input: { agent: spec.name } },
          at: new Date().toISOString()
        });
        emit({
          id: newId('evt'),
          sessionId,
          type: 'tool.progress',
          actorAgentId: null,
          payload: { toolCallId: acpToolCallId, tool: `acp:${spec.name}`, output: 'waiting for response...' },
          at: new Date().toISOString()
        });
      };
      const emitAcpActivityProgress = () => {
        const sections = [
          acpProcessOutput.trim(),
          acpResponseOutput ? `response stream:\n${acpResponseOutput}` : ''
        ].filter(Boolean);
        emit({
          id: newId('evt'),
          sessionId,
          type: 'tool.progress',
          actorAgentId: null,
          payload: {
            toolCallId: acpToolCallId,
            tool: `acp:${spec.name}`,
            output: sections.join('\n\n') || 'waiting for response...'
          },
          at: new Date().toISOString()
        });
      };

      emit({
        id: newId('evt'),
        sessionId,
        type: 'user.message',
        actorAgentId: null,
        payload: { messageId: userMsgId, text: displayText ?? text },
        at: new Date().toISOString()
      });
      store.insertMessage(userMsgId, sessionId, displayText ?? text, new Date().toISOString(), 'user');

      const rt = runtime.get(sessionId);
      emitAcpActivityStart();
      directDelegate(spec, composeAcpChannelPrompt(text, ambientContext), {
        sessionId,
        signal,
        sandboxRoots: sandboxRootsFor(sessionId, requireSession(sessionId).cwd, rt),
        backends: rt?.backends,
        toolFilter: rt?.toolFilter,
        extraTools: rt?.extraTools,
        extraSkills: rt?.extraSkills,
        mcpServers: channelDelegateMcpServers(cfg?.mcpServers, rt?.mcpServers),
        onChunk: (delta) => {
          emit({
            id: newId('evt'),
            sessionId,
            type: 'agent.token',
            actorAgentId: null,
            payload: { messageId: agentMsgId, agentName: spec.name, delta, index: tokenIndex++ },
            at: new Date().toISOString()
          });
          acpResponseOutput += delta;
          emitAcpActivityProgress();
        },
        onActivity: (output) => {
          acpProcessOutput = output;
          emitAcpActivityProgress();
        }
      })
        .then(async (fullText) => {
          log?.debug(
            { sessionId, event: 'session.forward_acp.complete', agentName: spec.name, fullText },
            'forward acp complete'
          );
          emit({
            id: newId('evt'),
            sessionId,
            type: 'tool.result',
            actorAgentId: null,
            payload: { toolCallId: acpToolCallId, tool: `acp:${spec.name}`, ok: true, result: 'completed' },
            at: new Date().toISOString()
          });
          store.insertMessage(agentMsgId, sessionId, fullText, new Date().toISOString(), 'assistant', {
            data: { agentName: spec.name }
          });
          emit({
            id: newId('evt'),
            sessionId,
            type: 'agent.message',
            actorAgentId: null,
            payload: { messageId: agentMsgId, agentName: spec.name, text: fullText },
            at: new Date().toISOString()
          });
          if (onComplete) {
            try {
              await onComplete(fullText);
            } catch (err) {
              process.stderr.write(`channel next dispatch error (${sessionId}): ${err}\n`);
            }
          }
          persistAndRetire(sessionId, round);
        })
        .catch((err: unknown) => {
          const { code, message } = extractError(err);
          log?.debug(
            { sessionId, event: 'session.forward_acp.error', agentName: spec.name, code, message },
            'forward acp error'
          );
          const hint = acpAuthGuidance(err, spec, ctx.deps.localeService?.t);
          const errorText = hint ? `${message}\n\n${hint}` : message;
          emit({
            id: newId('evt'),
            sessionId,
            type: 'tool.result',
            actorAgentId: null,
            payload: { toolCallId: acpToolCallId, tool: `acp:${spec.name}`, ok: false, result: errorText },
            at: new Date().toISOString()
          });
          store.insertMessage(
            agentMsgId,
            sessionId,
            code ? `[${code}] ${errorText}` : errorText,
            new Date().toISOString(),
            'assistant',
            {
              type: 'error',
              data: { agentName: spec.name }
            }
          );
          emit({
            id: newId('evt'),
            sessionId,
            type: 'agent.error',
            actorAgentId: null,
            payload: { messageId: agentMsgId, agentName: spec.name, code, message: errorText },
            at: new Date().toISOString()
          });
          try {
            persistAndRetire(sessionId, round);
          } catch (innerErr) {
            process.stderr.write(`forwardToAcp persistAndRetire error (${sessionId}): ${innerErr}\n`);
          }
        })
        .finally(() => aborts.delete(sessionId));

      return { accepted: true as const };
    },

    async forwardToNativeCli({
      sessionId,
      agentName,
      text,
      displayText
    }: {
      sessionId: SessionId;
      agentName: string;
      text: string;
      displayText?: string;
    }) {
      const session = requireSession(sessionId);
      assertWriteAllowed(session, 'http');
      const userRound: Event[] = [];
      const userEmit = makeEmit(userRound);
      const userMsgId = newId('msg');
      userEmit({
        id: newId('evt'),
        sessionId,
        type: 'user.message',
        actorAgentId: null,
        payload: { messageId: userMsgId, text: displayText ?? text },
        at: new Date().toISOString()
      });
      store.insertMessage(userMsgId, sessionId, displayText ?? text, new Date().toISOString(), 'user');
      persistAndRetire(sessionId, userRound);

      const emitNativeCliError = (err: unknown, fallbackCode?: string) => {
        const { code, message } = extractError(err);
        const agentMsgId = newId('msg');
        const round: Event[] = [];
        const emit = makeEmit(round);
        store.insertMessage(
          agentMsgId,
          sessionId,
          (code ?? fallbackCode) ? `[${code ?? fallbackCode}] ${message}` : message,
          new Date().toISOString(),
          'assistant',
          { type: 'error', data: { agentName } }
        );
        emit({
          id: newId('evt'),
          sessionId,
          type: 'agent.error',
          actorAgentId: null,
          payload: { messageId: agentMsgId, agentName, code: code ?? fallbackCode, message },
          at: new Date().toISOString()
        });
        persistAndRetire(sessionId, round);
      };

      const paths = ctx.deps.paths;
      if (!paths) {
        emitNativeCliError(new HandlerError('internal', 'daemon paths not configured'));
        return { accepted: true as const };
      }
      const nativeCliHost = ctx.deps.nativeCliHost;
      if (!nativeCliHost) {
        emitNativeCliError(new HandlerError('internal', 'native CLI host not configured'));
        return { accepted: true as const };
      }
      const cfg = await loadAll(paths.config, paths.profile);
      const spec = (cfg?.nativeCliAgents ?? []).find(
        (agent: NativeCliAgentConfig) => agent.name === agentName && agent.enabled !== false
      );
      if (!spec) {
        emitNativeCliError(new HandlerError('invalid', `native CLI agent "${agentName}" not found or disabled`));
        return { accepted: true as const };
      }
      if (!session.cwd) {
        emitNativeCliError(
          new HandlerError('invalid', `native CLI agent "${agentName}" requires a project working path`)
        );
        return { accepted: true as const };
      }
      log?.debug({ sessionId, event: 'session.forward_native_cli.start', agentName, text }, 'forward native cli start');
      try {
        const existing = nativeCliHost
          .list(sessionId)
          .sessions.find((candidate) => candidate.agentName === agentName && candidate.state === 'running');
        if (existing) {
          nativeCliHost.input(existing.id, { input: text.endsWith('\n') ? text : `${text}\n` });
          log?.debug(
            { sessionId, event: 'session.forward_native_cli.accepted', agentName, nativeCliSessionId: existing.id },
            'forward native cli accepted'
          );
          return { accepted: true as const };
        }
        const preflight = await nativeCliHost.preflight(agentName);
        if (preflight.state !== 'ready') {
          const reason = preflight.reason;
          const round: Event[] = [];
          const emit = makeEmit(round);
          const agentMsgId = newId('msg');
          if (preflight.state === 'not_authenticated' || preflight.state === 'unknown') {
            emit({
              id: newId('evt'),
              sessionId,
              type: 'native_cli.connection_required',
              actorAgentId: null,
              payload: {
                agentName,
                provider: spec.provider,
                reason,
                reconnectIn: 'studio'
              },
              at: new Date().toISOString()
            });
          }
          store.insertMessage(agentMsgId, sessionId, reason, new Date().toISOString(), 'assistant', {
            type: 'error',
            data: { agentName }
          });
          emit({
            id: newId('evt'),
            sessionId,
            type: 'agent.error',
            actorAgentId: null,
            payload: {
              messageId: agentMsgId,
              agentName,
              code:
                preflight.state === 'not_authenticated'
                  ? 'provider_auth_required'
                  : preflight.state === 'unavailable'
                    ? 'provider_unavailable'
                    : 'provider_readiness_unknown',
              message: reason
            },
            at: new Date().toISOString()
          });
          persistAndRetire(sessionId, round);
          log?.debug(
            {
              sessionId,
              event: 'session.forward_native_cli.preflight_blocked',
              agentName,
              provider: spec.provider,
              state: preflight.state
            },
            'forward native cli connection required'
          );
          return { accepted: true as const };
        }
        const nativeSession = await nativeCliHost.start({
          projectSessionId: sessionId,
          agentName,
          workingPath: session.cwd,
          launchMode: spec.defaultLaunchMode
        });
        nativeCliHost.input(nativeSession.id, { input: text.endsWith('\n') ? text : `${text}\n` });
        log?.debug(
          { sessionId, event: 'session.forward_native_cli.accepted', agentName, nativeCliSessionId: nativeSession.id },
          'forward native cli accepted'
        );
      } catch (err) {
        const { code, message } = extractError(err);
        log?.debug(
          { sessionId, event: 'session.forward_native_cli.error', agentName, code, message },
          'forward native cli error'
        );
        emitNativeCliError(err);
      }
      return { accepted: true as const };
    }
  };
  return handlers;
}
