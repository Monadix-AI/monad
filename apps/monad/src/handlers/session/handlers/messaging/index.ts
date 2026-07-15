import type { ChatMessage, Event, SendMessageRequest, Session, SessionId, SessionTransport } from '@monad/protocol';
import type { ImageAttachment } from '#/agent/index.ts';
import type { Tool, ToolBackends } from '#/capabilities/tools/types.ts';
import type { CommandBundle, LifecycleOps } from '#/handlers/commands/index.ts';
import type { EventSink, SessionContext } from '#/handlers/session/context.ts';

import { newId } from '@monad/protocol';

import { extractError } from '#/agent/index.ts';
import { emitCommandTurn, executeSessionCommand, tryRunSessionCommand } from '#/handlers/commands/index.ts';
import { HandlerError } from '#/handlers/handler-error.ts';
import { createAcpChannelDelegation } from '#/handlers/session/handlers/acp-channel-delegation.ts';
import { createForwardAcpHandler } from '#/handlers/session/handlers/forward-acp.ts';
import { createForwardExternalAgentHandler } from '#/handlers/session/handlers/forward-external-agent.ts';
import { createManagedExternalAgentDelivery } from '#/handlers/session/handlers/managed-external-agent-delivery.ts';
import { createMessagingNotifyHandlers } from '#/handlers/session/handlers/messaging/messaging-notify.ts';
import { createSendProjectMessageHandler } from '#/handlers/session/handlers/messaging/messaging-project.ts';
import { imageAttachments, messageTextWithAttachments } from '#/handlers/session/handlers/messaging-attachments.ts';
import { createSubscribeHandlers } from '#/handlers/session/handlers/messaging-subscribe.ts';

// Re-exported for existing import sites (tests import member/channel helpers from this module).
export {
  channelDelegateMcpServers,
  isChannelStructuredSession
} from '#/handlers/session/handlers/messaging-members.ts';

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

// Size of the live UI snapshot window. Older history is paged lazily over GET /ui-items.
// Keep ≥ a realistic single agent round so a tool call+result pair never straddles the window.
const _LIVE_SNAPSHOT_LIMIT = 80;

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
  ) =>
    override ??
    rt?.sandboxRoots ??
    (cwd ? [cwd] : sessionId.startsWith('ses_') ? agentSandboxRoots?.(sessionId as SessionId) : undefined);

  const runner = cmd ? { store, bus, lifecycle: cmd.lifecycle, commands: cmd.commands, ownerPrincipalId } : null;

  const managedExternalAgentDelivery = createManagedExternalAgentDelivery(ctx);
  const { deliverProjectMessageToManagedExternalAgentMembers, startManagedExternalAgentRuntimeWithRecovery } =
    managedExternalAgentDelivery;

  const acpDelegation = createAcpChannelDelegation(ctx, sandboxRootsFor);
  const { dispatchChannelNextTargets, deliverProjectMessageToAcpMembers } = acpDelegation;

  const forwardToAcp = createForwardAcpHandler(ctx, sandboxRootsFor);
  const forwardToExternalAgent = createForwardExternalAgentHandler(ctx, startManagedExternalAgentRuntimeWithRecovery);
  const { subscribe, subscribeUi, subscribeControl } = createSubscribeHandlers(ctx);

  const runtimeForSession = (sessionId: SessionId) => runtime.get(sessionId);
  const agentToolFilterForSession = (sessionId: SessionId) =>
    sessionId.startsWith('ses_') ? agentToolFilter?.(sessionId as SessionId) : undefined;

  async function send({
    sessionId,
    text,
    attachments,
    generate,
    continueFromHistory,
    ambientContext,
    onComplete
  }: { sessionId: SessionId; onComplete?: (text: string) => void | Promise<void> } & SendMessageRequest) {
    const effectiveText = messageTextWithAttachments(text, attachments);
    const modelAttachments = imageAttachments(attachments);
    const session = requireSession(sessionId);
    assertWriteAllowed(session, 'http');
    log?.debug(
      { sessionId, event: 'session.send.accept', text: effectiveText, generate, continueFromHistory, ambientContext },
      'session send accept'
    );
    if (continueFromHistory) {
      if (effectiveText || attachments?.length || generate === false) {
        throw new HandlerError('invalid', 'history continuation cannot include a new user message');
      }
      const lastMessage = store.listMessagesWithLineage(sessionId).at(-1);
      if (lastMessage?.role !== 'user') {
        throw new HandlerError('invalid', 'history continuation requires a trailing user message');
      }
    }
    // `busy` = a prior turn is still streaming for this session — the concurrency guard refuses a
    // command that would race it (the command check runs before beginRun, so aborts reflects prior).
    if (
      !continueFromHistory &&
      runner &&
      (await tryRunSessionCommand(runner, session, effectiveText, { busy: aborts.has(sessionId) }))
    )
      return { accepted: true as const };
    if (generate === false) {
      const messageId = newId('msg');
      const round: Event[] = [];
      store.insertMessage(messageId, sessionId, effectiveText, new Date().toISOString(), 'user');
      makeEmit(round)({
        id: newId('evt'),
        sessionId: sessionId as SessionId,
        type: 'user.message',
        actorAgentId: null,
        payload: { messageId, text: effectiveText },
        at: new Date().toISOString()
      });
      persistAndRetire(sessionId, round);
      log?.debug(
        { sessionId, event: 'session.send.recorded', messageId, text: effectiveText },
        'session send recorded'
      );
      return { accepted: true as const };
    }
    const { round, signal } = beginRun(sessionId);
    const rt = runtimeForSession(sessionId);
    const loop = agent.loop(makeEmit(round), {
      modelOverride: session.model,
      generationParams: session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : undefined,
      ambientContext,
      sandboxRoots: sandboxRootsFor(sessionId, session.cwd, rt),
      agentId: session.agentIds[0],
      defaultCwd: session.cwd,
      extraTools: rt?.extraTools,
      extraSkills: rt?.extraSkills,
      toolFilter: composeFilter(rt?.toolFilter, agentToolFilterForSession(sessionId))
    });
    const run = continueFromHistory
      ? loop.runStreamFromHistory(sessionId as SessionId, signal)
      : loop.runStream(sessionId as SessionId, effectiveText, signal, modelAttachments);
    run
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
  }

  const { sendProjectMessage, sendChannelMessage } = createSendProjectMessageHandler(ctx, {
    send,
    forwardToAcp,
    forwardToExternalAgent,
    deliverProjectMessageToAcpMembers,
    dispatchChannelNextTargets,
    deliverProjectMessageToManagedExternalAgentMembers,
    runtimeForSession
  });

  const {
    notifyManagedExternalAgentProjectMembers,
    notifyManagedExternalAgentDirectMessage,
    completeManagedExternalAgentProjectMessage,
    completeManagedExternalAgentProviderMessage
  } = createMessagingNotifyHandlers(ctx, managedExternalAgentDelivery);

  const handlers = {
    send,
    sendProjectMessage,
    sendChannelMessage,
    notifyManagedExternalAgentProjectMembers,
    notifyManagedExternalAgentDirectMessage,
    completeManagedExternalAgentProjectMessage,
    completeManagedExternalAgentProviderMessage,

    async sendInline(
      { sessionId, text, continueFromHistory }: { sessionId: SessionId } & SendMessageRequest,
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
      if (continueFromHistory) {
        if (text) throw new HandlerError('invalid', 'history continuation cannot include a new user message');
        const lastMessage = store.listMessagesWithLineage(sessionId).at(-1);
        if (lastMessage?.role !== 'user') {
          throw new HandlerError('invalid', 'history continuation requires a trailing user message');
        }
      }
      if (
        !continueFromHistory &&
        runner &&
        (await tryRunSessionCommand(runner, session, text, { sink, busy: aborts.has(sessionId) }))
      )
        return;
      // Out-of-band per-session runtime config (sandbox roots / session-scoped MCP tools / delegating
      // backends) set via configureRuntime — used when the caller doesn't pass explicit runOpts (the
      // ACP bridge proxies turns over HTTP and can't ship in-process backends, so it configures the
      // daemon out-of-band).
      const rt = runtimeForSession(sessionId);
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
          toolFilter: composeFilter(runOpts?.toolFilter ?? rt?.toolFilter, agentToolFilterForSession(sessionId)),
          ambientContext: runOpts?.ambientContext,
          extraTools: runOpts?.extraTools ?? rt?.extraTools,
          extraSkills: rt?.extraSkills,
          sandboxRoots,
          defaultCwd: session.cwd,
          modelOverride: session.model,
          generationParams: session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : undefined
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
        if (continueFromHistory) await loop.runStreamFromHistory(sessionId as SessionId, signal);
        else await loop.runStream(sessionId as SessionId, text, signal, runOpts?.attachments);
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
      const rt = runtimeForSession(sessionId);
      const loop = agent.loop(makeEmit(round), {
        modelOverride: session.model,
        generationParams: session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : undefined,
        sandboxRoots: sandboxRootsFor(sessionId, session.cwd, rt),
        agentId: session.agentIds[0],
        defaultCwd: session.cwd,
        extraTools: rt?.extraTools,
        extraSkills: rt?.extraSkills,
        toolFilter: composeFilter(rt?.toolFilter, agentToolFilterForSession(sessionId))
      });
      try {
        const msg = await loop.runBlock(sessionId as SessionId, text);
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

    subscribe,
    subscribeUi,
    subscribeControl,

    forwardToAcp,
    forwardToExternalAgent
  };
  return handlers;
}
