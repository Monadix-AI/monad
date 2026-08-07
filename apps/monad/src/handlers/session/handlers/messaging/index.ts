import type {
  ChatMessage,
  Event,
  MessageId,
  MessageOrigin,
  SendMessageRequest,
  SessionId,
  SessionTransport
} from '@monad/protocol';
import type { ImageAttachment } from '#/agent/index.ts';
import type { Tool, ToolBackends } from '#/capabilities/tools/types.ts';
import type { CommandBundle, LifecycleOps } from '#/handlers/commands/index.ts';
import type { EventSink, SessionContext } from '#/handlers/session/context.ts';

import { newId, parseEventPayload } from '@monad/protocol';

import { extractError } from '#/agent/index.ts';
import { emitCommandTurn, executeSessionCommand, tryRunSessionCommand } from '#/handlers/commands/index.ts';
import { HandlerError } from '#/handlers/handler-error.ts';
import { createAcpChannelDelegation } from '#/handlers/session/handlers/acp-channel-delegation.ts';
import { createForwardAcpHandler } from '#/handlers/session/handlers/forward-acp.ts';
import { createForwardMeshAgentHandler } from '#/handlers/session/handlers/forward-mesh-agent.ts';
import { createManagedMeshAgentDelivery } from '#/handlers/session/handlers/managed-mesh-agent-delivery.ts';
import { createMeshStateSubscribeHandler } from '#/handlers/session/handlers/mesh-state-subscribe.ts';
import { createMessagingNotifyHandlers } from '#/handlers/session/handlers/messaging/messaging-notify.ts';
import { createSendProjectMessageHandler } from '#/handlers/session/handlers/messaging/messaging-project.ts';
import {
  imageAttachments,
  messageAttachmentPresentations,
  messageTextWithAttachments,
  persistMessageAttachmentPresentations
} from '#/handlers/session/handlers/messaging-attachments.ts';
import { createSubscribeHandlers } from '#/handlers/session/handlers/messaging-subscribe.ts';
import { assertSessionWriteAuthority } from '#/handlers/session/transport-authority.ts';
import { ReplyTargetError } from '#/store/db/message-mutations.ts';

// Re-exported for existing import sites (tests import member/channel helpers from this module).
export {
  channelDelegateMcpServers,
  isChannelStructuredSession
} from '#/handlers/session/handlers/messaging-members.ts';

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

/**
 * Ingress provenance for one message write. A caller that knows WHO it is (channel dispatch, ACP,
 * openai-compat, a2a) declares it; everyone else records the bare transport.
 *
 * Deliberately no fallback to the session's own origin: the transport alone does not identify a
 * client — web, TUI, openai-compat and a2a all write over `http` — so borrowing the session
 * creator's identity would stamp a web reply into an api-born session as "sent from openai-compat".
 * An unnamed write is recorded as unnamed; provenance is never guessed.
 */
function messageOriginFor(transport: SessionTransport, override?: MessageOrigin): MessageOrigin {
  return override ?? { transport };
}

function completedAssistantText(event: Event): string | null {
  if (event.type !== 'session.message.completed') return null;
  const message = parseEventPayload('session.message.completed', event.payload).message;
  return message.role === 'assistant' ? message.text : null;
}

export function createMessagingHandlers(ctx: SessionContext, cmd?: MessagingCommandDeps) {
  const {
    deps: { agent, bus, cache, store, sessionSandbox, agentToolFilter, agentSandboxRoots, log },
    aborts,
    steers,
    runtime,
    beginRun,
    enqueueSteers,
    trackRun,
    makeEmit,
    touchSession,
    persistAndRetire,
    requireSession,
    messageIngress
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

  const runner = cmd ? { store, messageIngress, lifecycle: cmd.lifecycle, commands: cmd.commands } : null;

  const replyTargetHandlerError = (error: ReplyTargetError) =>
    new HandlerError(error.code === 'reply_target_not_found' ? 'not_found' : 'invalid', error.code, error.code);

  const withReplyTargetContract = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ReplyTargetError) throw replyTargetHandlerError(error);
      throw error;
    }
  };

  const assertRequestedReplyTarget = (sessionId: SessionId, replyToMessageId?: MessageId) => {
    if (!replyToMessageId) return;
    try {
      store.assertReplyTarget(sessionId, replyToMessageId);
    } catch (error) {
      if (error instanceof ReplyTargetError) throw replyTargetHandlerError(error);
      throw error;
    }
  };

  const assertReplyRelationControlMode = (
    replyToMessageId: MessageId | undefined,
    control: { steer?: boolean; continueFromHistory?: boolean }
  ) => {
    if (replyToMessageId && (control.steer || control.continueFromHistory)) {
      throw new HandlerError('invalid', 'reply_relation_not_supported', 'reply_relation_not_supported');
    }
  };

  const managedMeshAgentDelivery = createManagedMeshAgentDelivery(ctx);
  const { deliverProjectMessageToManagedMeshAgentMembers, startManagedMeshAgentRuntimeWithRecovery } =
    managedMeshAgentDelivery;

  const acpDelegation = createAcpChannelDelegation(ctx, sandboxRootsFor);
  const { dispatchChannelNextTargets, deliverProjectMessageToAcpMembers } = acpDelegation;

  const forwardToAcp = createForwardAcpHandler(ctx, sandboxRootsFor);
  const forwardToMeshAgent = createForwardMeshAgentHandler(ctx, startManagedMeshAgentRuntimeWithRecovery);
  const { subscribe, subscribeUi, subscribeControl, subscribeMessageGeneration, resolveReplayAnchor } =
    createSubscribeHandlers(ctx);
  const { subscribeMeshState, resolveMeshStateAnchor } = createMeshStateSubscribeHandler(ctx);

  const runtimeForSession = (sessionId: SessionId) => runtime.get(sessionId);
  const agentToolFilterForSession = (sessionId: SessionId) =>
    sessionId.startsWith('ses_') ? agentToolFilter?.(sessionId as SessionId) : undefined;
  const trailingContextMessage = (sessionId: SessionId) =>
    store
      .listMessages(sessionId)
      .findLast(
        (message) =>
          message.includeInContext !== false &&
          message.stream.status !== 'pending' &&
          message.stream.status !== 'streaming'
      );
  const attachmentPresentations = (
    sessionId: SessionId,
    attachments: SendMessageRequest['attachments'],
    workspaceDir: string | undefined
  ) => {
    return workspaceDir
      ? persistMessageAttachmentPresentations(attachments, {
          registerAttachments: (records) => store.registerMessageAttachments(records),
          sessionId,
          workspaceDir
        }).catch((error: unknown) => {
          log?.warn({ error, sessionId }, 'message attachment persistence failed');
          return messageAttachmentPresentations(attachments);
        })
      : Promise.resolve(messageAttachmentPresentations(attachments));
  };

  async function send({
    sessionId,
    text,
    attachments,
    generate,
    steer,
    steerMessages,
    continueFromHistory,
    ambientContext,
    replyToMessageId,
    onComplete,
    origin
  }: {
    sessionId: SessionId;
    onComplete?: (text: string) => void | Promise<void>;
    /** Explicit ingress provenance (channel-routed project sends); absent derives from 'http'. */
    origin?: MessageOrigin;
  } & SendMessageRequest) {
    let effectiveText = messageTextWithAttachments(text, attachments);
    const modelAttachments = imageAttachments(attachments);
    const session = requireSession(sessionId);
    assertSessionWriteAuthority(session);
    assertReplyRelationControlMode(replyToMessageId, { steer, continueFromHistory });
    assertRequestedReplyTarget(sessionId, replyToMessageId);
    if (steerMessages && !steer) throw new HandlerError('invalid', 'steerMessages requires steer mode');
    if (steerMessages && effectiveText) throw new HandlerError('invalid', 'steer batch cannot include text');
    const requestedSteers = steerMessages ?? (effectiveText ? [effectiveText] : []);
    const steerOrigin = messageOriginFor('http', origin);
    if (steer && requestedSteers.length === 0) throw new HandlerError('invalid', 'steer requires a message');
    if (steer && (continueFromHistory || generate === false || attachments?.length)) {
      throw new HandlerError('invalid', 'steer accepts text only and cannot continue history');
    }
    touchSession(sessionId);
    if (
      steer &&
      enqueueSteers(
        sessionId,
        requestedSteers.map((text) => ({ text, origin: steerOrigin }))
      )
    ) {
      return { accepted: true as const };
    }
    if (steer) {
      await ctx.waitForRun(sessionId);
      if (steerMessages) throw new HandlerError('invalid', 'steer batch requires an active session run');
    }
    if (continueFromHistory) {
      if (effectiveText || attachments?.length || generate === false) {
        throw new HandlerError('invalid', 'history continuation cannot include a new user message');
      }
      const lastMessage = trailingContextMessage(sessionId);
      if (lastMessage?.role !== 'user') {
        throw new HandlerError('invalid', 'history continuation requires a trailing user message');
      }
    }
    // `busy` = a prior turn is still streaming for this session — the concurrency guard refuses a
    // command that would race it (the command check runs before beginRun, so aborts reflects prior).
    if (
      !continueFromHistory &&
      runner &&
      (await tryRunSessionCommand(runner, session, effectiveText, {
        busy: aborts.has(sessionId),
        replyToMessageId
      }))
    )
      return { accepted: true as const };
    const rt = runtimeForSession(sessionId);
    const sandboxRoots = sandboxRootsFor(sessionId, session.cwd, rt) ?? (await sessionSandbox?.ensure(sessionId));
    const presentedAttachments = await attachmentPresentations(
      sessionId,
      attachments,
      sandboxRoots?.[0] ?? ctx.deps.hookCwd
    );
    effectiveText = messageTextWithAttachments(text, attachments, presentedAttachments);
    log?.debug(
      { sessionId, event: 'session.send.accept', text: effectiveText, generate, continueFromHistory, ambientContext },
      'session send accept'
    );
    const presentation = presentedAttachments.length
      ? { data: { attachments: presentedAttachments }, text: text.trim() }
      : undefined;
    if (generate === false) {
      const message = await messageIngress.deliver({
        transcriptTargetId: sessionId,
        idempotencyKey: newId('idem'),
        producer: { kind: 'user' },
        role: 'user',
        type: 'text',
        text: presentation?.text ?? effectiveText,
        ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
        ...(presentation?.data ? { data: presentation.data } : {}),
        metadata: { origin: messageOriginFor('http', origin) }
      });
      const messageId = message.id;
      log?.debug(
        { sessionId, event: 'session.send.recorded', messageId, text: effectiveText },
        'session send recorded'
      );
      return { accepted: true as const };
    }
    const { round, signal } = beginRun(sessionId);
    let finalText: string | null = null;
    const loop = agent.loop(makeEmit(round), {
      modelOverride: session.model,
      generationParams: session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : undefined,
      ambientContext,
      sandboxRoots,
      agentId: session.agentIds[0],
      defaultCwd: session.cwd,
      extraTools: rt?.extraTools,
      extraSkills: [...(ctx.deps.agentSkills?.(sessionId) ?? []), ...(rt?.extraSkills ?? [])],
      steers: steers.get(sessionId),
      toolFilter: composeFilter(rt?.toolFilter, agentToolFilterForSession(sessionId)),
      linkAssistantReplies: session.projectId !== null && session.projectId !== undefined,
      messageFanout: (event) => {
        cache.append(event);
        finalText = completedAssistantText(event) ?? finalText;
      }
    });
    const run = continueFromHistory
      ? loop.runStreamFromHistory(sessionId as SessionId, signal)
      : loop.runStream(sessionId as SessionId, effectiveText, signal, modelAttachments, presentation, {
          replyToMessageId,
          origin: messageOriginFor('http', origin)
        });
    const execution = run
      .then(async () => {
        persistAndRetire(sessionId, round);
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
      });
    trackRun(sessionId, signal, execution);
    return { accepted: true as const };
  }

  const { sendProjectMessage, sendChannelMessage } = createSendProjectMessageHandler(ctx, {
    send,
    forwardToAcp,
    forwardToMeshAgent,
    deliverProjectMessageToAcpMembers,
    dispatchChannelNextTargets,
    deliverProjectMessageToManagedMeshAgentMembers,
    runtimeForSession
  });

  const {
    notifyManagedMeshAgentProjectMembers,
    notifyManagedMeshAgentDirectMessage,
    resolveManagedMeshAgentDirectTarget,
    completeManagedMeshAgentProjectMessage,
    completeManagedMeshAgentProviderMessage
  } = createMessagingNotifyHandlers(ctx, managedMeshAgentDelivery);

  const handlers = {
    send,
    sendProjectMessage,
    sendChannelMessage,
    notifyManagedMeshAgentProjectMembers,
    notifyManagedMeshAgentDirectMessage,
    resolveManagedMeshAgentDirectTarget,
    completeManagedMeshAgentProjectMessage,
    completeManagedMeshAgentProviderMessage,

    async sendInline(
      {
        sessionId,
        text,
        attachments,
        steer,
        continueFromHistory,
        replyToMessageId
      }: { sessionId: SessionId } & SendMessageRequest,
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
        onReady?: () => void;
        signal?: AbortSignal;
        /** Explicit ingress provenance for the turn's user row (channel dispatch supplies sender detail). */
        origin?: MessageOrigin;
      }
    ) {
      let effectiveText = messageTextWithAttachments(text, attachments);
      const modelAttachments = imageAttachments(attachments);
      const session = requireSession(sessionId);
      assertSessionWriteAuthority(session);
      assertReplyRelationControlMode(replyToMessageId, { steer, continueFromHistory });
      assertRequestedReplyTarget(sessionId, replyToMessageId);
      touchSession(sessionId);
      if (continueFromHistory) {
        if (effectiveText || attachments?.length) {
          throw new HandlerError('invalid', 'history continuation cannot include a new user message');
        }
        const lastMessage = trailingContextMessage(sessionId);
        if (lastMessage?.role !== 'user') {
          throw new HandlerError('invalid', 'history continuation requires a trailing user message');
        }
      }
      if (!continueFromHistory && runner) {
        const handled = await withReplyTargetContract(() =>
          tryRunSessionCommand(runner, session, effectiveText, {
            sink,
            busy: aborts.has(sessionId),
            replyToMessageId
          })
        );
        if (handled) {
          runOpts?.onReady?.();
          return;
        }
      }
      // Out-of-band per-session runtime config (sandbox roots / session-scoped MCP tools / delegating
      // backends) set via configureRuntime — used when the caller doesn't pass explicit runOpts (the
      // ACP bridge proxies turns over HTTP and can't ship in-process backends, so it configures the
      // daemon out-of-band).
      const rt = runtimeForSession(sessionId);
      // Shared precedence (runOpts override > rt > session.cwd > per-agent), then this session's
      // disposable ephemeral root (sandbox mode 'ephemeral'), then the loop's global default.
      const sandboxRoots =
        sandboxRootsFor(sessionId, session.cwd, rt, runOpts?.sandboxRoots) ?? (await sessionSandbox?.ensure(sessionId));
      const presentedAttachments = await attachmentPresentations(
        sessionId,
        attachments,
        sandboxRoots?.[0] ?? ctx.deps.hookCwd
      );
      effectiveText = messageTextWithAttachments(text, attachments, presentedAttachments);
      const presentation = presentedAttachments.length
        ? { data: { attachments: presentedAttachments }, text: text.trim() }
        : undefined;
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
          extraSkills: [...(ctx.deps.agentSkills?.(sessionId) ?? []), ...(rt?.extraSkills ?? [])],
          steers: steers.get(sessionId),
          sandboxRoots,
          defaultCwd: session.cwd,
          modelOverride: session.model,
          generationParams: session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : undefined,
          linkAssistantReplies: session.projectId !== null && session.projectId !== undefined,
          messageFanout: (event) => {
            cache.append(event);
            sink(event);
          }
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
      const requestSignal = runOpts?.signal;
      const abortFromRequest = (): void => {
        const controller = aborts.get(sessionId);
        if (controller?.signal === signal) controller.abort(requestSignal?.reason);
      };
      requestSignal?.addEventListener('abort', abortFromRequest, { once: true });
      if (requestSignal?.aborted) abortFromRequest();
      const execution = (async () => {
        try {
          if (continueFromHistory) {
            await loop.runStreamFromHistory(sessionId as SessionId, signal, {
              onHistoryPrepared: runOpts?.onReady
            });
          } else
            await loop.runStream(
              sessionId as SessionId,
              effectiveText,
              signal,
              modelAttachments ?? runOpts?.attachments,
              presentation,
              {
                replyToMessageId,
                origin: messageOriginFor(runOpts?.transport ?? 'http', runOpts?.origin),
                onInputCommitted: runOpts?.onReady
              }
            );
        } finally {
          requestSignal?.removeEventListener('abort', abortFromRequest);
          oob();
          persistAndRetire(sessionId, round);
        }
      })();
      await withReplyTargetContract(() => trackRun(sessionId, signal, execution));
    },

    async generate({
      sessionId,
      text,
      steer,
      continueFromHistory,
      replyToMessageId
    }: { sessionId: SessionId } & SendMessageRequest) {
      const session = requireSession(sessionId);
      assertSessionWriteAuthority(session);
      assertReplyRelationControlMode(replyToMessageId, { steer, continueFromHistory });
      assertRequestedReplyTarget(sessionId, replyToMessageId);
      touchSession(sessionId);
      log?.debug({ sessionId, event: 'session.generate.start', text }, 'session generate start');
      if (runner) {
        const result = await executeSessionCommand(runner, session, text, { busy: aborts.has(sessionId) });
        if (result !== null) {
          const message = await emitCommandTurn(messageIngress, undefined, sessionId, text, result, replyToMessageId);
          return { message };
        }
      }
      const { round, signal } = beginRun(sessionId);
      const rt = runtimeForSession(sessionId);
      const loop = agent.loop(makeEmit(round), {
        modelOverride: session.model,
        generationParams: session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : undefined,
        sandboxRoots: sandboxRootsFor(sessionId, session.cwd, rt),
        agentId: session.agentIds[0],
        defaultCwd: session.cwd,
        extraTools: rt?.extraTools,
        extraSkills: [...(ctx.deps.agentSkills?.(sessionId) ?? []), ...(rt?.extraSkills ?? [])],
        toolFilter: composeFilter(rt?.toolFilter, agentToolFilterForSession(sessionId)),
        linkAssistantReplies: session.projectId !== null && session.projectId !== undefined,
        messageFanout: (event) => cache.append(event)
      });
      const execution = (async () => {
        try {
          const msg = await loop.runBlock(sessionId as SessionId, text, undefined, signal, {
            replyToMessageId,
            origin: messageOriginFor('http')
          });
          log?.debug({ sessionId, event: 'session.generate.complete', text: msg.text }, 'session generate complete');
          const message: ChatMessage = {
            id: msg.id as ChatMessage['id'],
            sessionId: msg.sessionId as ChatMessage['sessionId'],
            role: msg.role,
            text: msg.text,
            type: 'text',
            stream: { status: 'complete' },
            active: true,
            ...(msg.replyToMessageId === undefined ? {} : { replyToMessageId: msg.replyToMessageId }),
            createdAt: msg.createdAt
          };
          return { message };
        } catch (err) {
          if (err instanceof ReplyTargetError) throw replyTargetHandlerError(err);
          // The model/gateway failed upstream — the daemon itself is healthy, so 502
          // (Bad Gateway) is the accurate status, not 500. runBlock already persisted
          // and emitted the failure; surface the parsed message in the response body.
          const { code, message } = extractError(err);
          log?.debug({ sessionId, event: 'session.generate.error', code, message }, 'session generate error');
          throw new HandlerError('bad_gateway', code ? `[${code}] ${message}` : message);
        } finally {
          persistAndRetire(sessionId, round);
        }
      })();
      return trackRun(sessionId, signal, execution);
    },

    subscribe,
    subscribeUi,
    subscribeControl,
    subscribeMessageGeneration,
    resolveReplayAnchor,
    subscribeMeshState,
    resolveMeshStateAnchor,

    forwardToAcp,
    forwardToMeshAgent
  };
  return handlers;
}
