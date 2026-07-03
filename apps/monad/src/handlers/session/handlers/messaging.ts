import type { AcpAgentConfig, NativeCliAgentConfig } from '@monad/home';
import type {
  ChatMessage,
  Event,
  MessageAttachmentRef,
  SendMessageRequest,
  SessionId,
  SessionTransport,
  TranscriptTarget,
  TranscriptTargetId
} from '@monad/protocol';
import type { ImageAttachment } from '@/agent/index.ts';
import type { Tool, ToolBackends } from '@/capabilities/tools/types.ts';
import type { CommandBundle, LifecycleOps } from '@/handlers/commands/index.ts';
import type { EventSink, SessionContext } from '@/handlers/session/context.ts';
import type { ManagedNativeCliProjectMessageSender } from '@/handlers/session/handlers/messaging-notices.ts';

import { loadAll } from '@monad/home';
import { newId } from '@monad/protocol';

import { extractError } from '@/agent/index.ts';
import { buildChannelTurnContext, type ChannelParticipant } from '@/agent/prompts/channel.ts';
import { emitCommandTurn, executeSessionCommand, tryRunSessionCommand } from '@/handlers/commands/index.ts';
import { HandlerError } from '@/handlers/handler-error.ts';
import {
  CHANNEL_HOST_EXT_KEY,
  normalizeChannelModeratorId,
  routeChannelMessage
} from '@/handlers/session/channel-routing.ts';
import { createAcpChannelDelegation } from '@/handlers/session/handlers/acp-channel-delegation.ts';
import { createForwardAcpHandler } from '@/handlers/session/handlers/forward-acp.ts';
import { createForwardNativeCliHandler } from '@/handlers/session/handlers/forward-native-cli.ts';
import { createManagedNativeCliDelivery } from '@/handlers/session/handlers/managed-native-cli-delivery.ts';
import {
  channelDelegateMcpServers,
  isWorkplaceProjectTarget,
  nativeCliProjectMemberDisplayName,
  nativeCliProjectMemberRuntimeName,
  nativeCliProjectMemberTemplateName,
  workplaceProjectMembers
} from '@/handlers/session/handlers/messaging-members.ts';
import { createSubscribeHandlers } from '@/handlers/session/handlers/messaging-subscribe.ts';

export type { ManagedNativeCliProjectMessageSender } from '@/handlers/session/handlers/messaging-notices.ts';

// Re-exported for existing import sites (tests import member/channel helpers from this module).
export {
  channelDelegateMcpServers,
  isChannelStructuredSession
} from '@/handlers/session/handlers/messaging-members.ts';

// Access control reads the write policy STORED on the session (origin.writableBy) — derived from the
// originating surface at creation, overridable per-session — not a label→transport lookup at the call
// site. Sessions with no origin stay unrestricted.
function assertWriteAllowed(session: TranscriptTarget, transport: SessionTransport): void {
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
    requireTranscriptTarget
  } = ctx;

  // Effective fs/shell sandbox roots for a turn, single precedence chain so every call site agrees:
  // an explicit per-turn override (the editor's workspace) > the per-session runtime entry (set by
  // applyWorkspaceRuntime on /workdir, create, update) > the persisted session.cwd (source of truth,
  // so a working folder survives a daemon restart that left the in-memory runtime map empty) > the
  // bound agent's per-agent override. A site that also has an async ephemeral fallback applies it to
  // this result (`?? await …`).
  const sandboxRootsFor = (
    sessionId: TranscriptTargetId,
    cwd: string | undefined,
    rt: { sandboxRoots?: string[] } | undefined,
    override?: string[]
  ) =>
    override ??
    rt?.sandboxRoots ??
    (cwd ? [cwd] : sessionId.startsWith('ses_') ? agentSandboxRoots?.(sessionId as SessionId) : undefined);

  const runner = cmd ? { store, bus, lifecycle: cmd.lifecycle, commands: cmd.commands, ownerPrincipalId } : null;

  const managedNativeCliDelivery = createManagedNativeCliDelivery(ctx);
  const {
    completeManagedNativeCliThinking,
    retireManagedNativeCliThinking,
    deliverProjectMessageToManagedNativeCliMembers,
    deliverDirectMessageToManagedNativeCliMember,
    startManagedNativeCliRuntimeWithRecovery
  } = managedNativeCliDelivery;

  const acpDelegation = createAcpChannelDelegation(ctx, sandboxRootsFor);
  const { dispatchChannelNextTargets, deliverProjectMessageToAcpMembers } = acpDelegation;

  const forwardToAcp = createForwardAcpHandler(ctx, sandboxRootsFor);
  const forwardToNativeCli = createForwardNativeCliHandler(ctx, startManagedNativeCliRuntimeWithRecovery);
  const { subscribe, subscribeUi, subscribeControl } = createSubscribeHandlers(ctx);

  const runtimeForTranscriptTarget = (sessionId: TranscriptTargetId) => runtime.get(sessionId);
  const agentToolFilterForTranscriptTarget = (sessionId: TranscriptTargetId) =>
    sessionId.startsWith('ses_') ? agentToolFilter?.(sessionId as SessionId) : undefined;

  const handlers = {
    async send({
      sessionId,
      text,
      generate,
      ambientContext,
      onComplete
    }: { sessionId: TranscriptTargetId; onComplete?: (text: string) => void | Promise<void> } & SendMessageRequest) {
      const session = requireTranscriptTarget(sessionId);
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
          transcriptTargetId: sessionId,
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
      const rt = runtimeForTranscriptTarget(sessionId);
      const loop = agent.loop(makeEmit(round), {
        modelOverride: session.model,
        ambientContext,
        sandboxRoots: sandboxRootsFor(sessionId, session.cwd, rt),
        defaultCwd: session.cwd,
        extraTools: rt?.extraTools,
        extraSkills: rt?.extraSkills,
        toolFilter: composeFilter(rt?.toolFilter, agentToolFilterForTranscriptTarget(sessionId))
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

    async sendProjectMessage({ sessionId, text }: { sessionId: TranscriptTargetId; text: string }) {
      const session = requireTranscriptTarget(sessionId);
      const paths = ctx.deps.paths;
      const cfg = paths ? await loadAll(paths.config, paths.profile) : null;
      const acpAgents = (cfg?.acpAgents ?? []).filter((agent: AcpAgentConfig) => agent.enabled !== false);
      const nativeCliAgents = (cfg?.nativeCliAgents ?? []).filter(
        (agent: NativeCliAgentConfig) => agent.enabled !== false
      );
      const isWorkplaceProject = isWorkplaceProjectTarget(session);
      const projectMembers = isWorkplaceProject ? workplaceProjectMembers(session) : [];
      const projectAcpAgentNames = projectMembers
        .filter((member) => member.type === 'acp')
        .map((member) => member.name);
      const projectNativeCliAgentNames = projectMembers
        .filter((member) => member.type === 'native-cli')
        .map((member) => nativeCliProjectMemberRuntimeName(member));
      const hasMonadMember = projectMembers.some((member) => member.type === 'monad');
      const moderatorAgentId = normalizeChannelModeratorId(session.origin?.ext?.[CHANNEL_HOST_EXT_KEY]);
      const route = routeChannelMessage({
        text,
        moderatorAgentId,
        acpAgentNames: isWorkplaceProject ? projectAcpAgentNames : acpAgents.map((agent: AcpAgentConfig) => agent.name),
        nativeCliAgentNames: isWorkplaceProject
          ? projectNativeCliAgentNames
          : nativeCliAgents.map((agent: NativeCliAgentConfig) => agent.name)
      });
      if (route.kind === 'none') return { accepted: true as const };
      const targetRole = moderatorAgentId && !route.direct ? 'moderator' : 'agent';
      log?.debug(
        {
          sessionId,
          transcriptTargetId: sessionId,
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
      const nativeCliParticipants: ChannelParticipant[] = isWorkplaceProject
        ? projectMembers
            .filter((member) => member.type === 'native-cli')
            .map((member) => {
              const templateName = nativeCliProjectMemberTemplateName(member);
              return {
                id: `native-cli:${nativeCliProjectMemberRuntimeName(member)}`,
                name: nativeCliProjectMemberDisplayName(member),
                kind: 'native-cli' as const,
                description: `template:${templateName}`
              };
            })
        : nativeCliAgents.map((agent: NativeCliAgentConfig) => ({
            id: `native-cli:${agent.name}`,
            name: agent.name,
            kind: 'native-cli' as const
          }));
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
        ...nativeCliParticipants
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
      const mcpServers = channelDelegateMcpServers(cfg?.mcpServers, runtimeForTranscriptTarget(sessionId)?.mcpServers);
      const isPublicProjectFanout = isWorkplaceProject && route.kind === 'send' && !route.direct && !moderatorAgentId;
      const publicAmbientContext = buildChannelTurnContext({
        channelId: session.title,
        sessionId,
        routeKind: route.kind,
        targetName: 'project members',
        targetRole,
        responseMode,
        moderatorAgentId,
        participants,
        targetMention: route.targetMention
      });
      const dispatchStructuredNext =
        ambientContext && (responseMode === 'moderator_structured' || responseMode === 'direct_structured')
          ? (responseText: string) =>
              dispatchChannelNextTargets({
                sessionId,
                responseText,
                ambientContext,
                acpAgents,
                mcpServers
              })
          : undefined;
      if (route.kind === 'send') {
        if (isPublicProjectFanout) {
          const shouldRunMonad = hasMonadMember || route.generate === true;
          const result = shouldRunMonad
            ? await handlers.send({
                sessionId,
                text: route.text,
                ambientContext: publicAmbientContext
              })
            : await handlers.send({ sessionId, text: route.text, generate: false });
          const humanSender = { kind: 'human' as const, name: cfg?.principal.displayName ?? 'User', id: 'human' };
          await Promise.all([
            deliverProjectMessageToManagedNativeCliMembers({
              session,
              nativeCliAgents,
              text: route.text,
              sender: humanSender
            }),
            deliverProjectMessageToAcpMembers({
              session,
              acpAgents,
              mcpServers: cfg?.mcpServers,
              text: route.text,
              ambientContext: publicAmbientContext
            })
          ]);
          return result;
        }
        const routeGenerate =
          moderatorAgentId || !isWorkplaceProject ? route.generate : hasMonadMember ? route.generate : false;
        const result = await handlers.send({
          sessionId,
          text: route.text,
          generate: routeGenerate,
          ambientContext,
          onComplete: dispatchStructuredNext
        });
        if (!route.direct && route.generate === false) {
          await deliverProjectMessageToManagedNativeCliMembers({
            session,
            nativeCliAgents,
            text: route.text,
            sender: { kind: 'human', name: cfg?.principal.displayName ?? 'User', id: 'human' }
          });
        }
        return result;
      }
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

    async sendChannelMessage({ sessionId, text }: { sessionId: TranscriptTargetId; text: string }) {
      return handlers.sendProjectMessage({ sessionId, text });
    },

    async notifyManagedNativeCliProjectMembers({
      sessionId,
      text,
      sender,
      exceptAgentName
    }: {
      sessionId: TranscriptTargetId;
      text: string;
      sender?: ManagedNativeCliProjectMessageSender;
      exceptAgentName?: string;
    }) {
      const session = requireTranscriptTarget(sessionId);
      const paths = ctx.deps.paths;
      const cfg = paths ? await loadAll(paths.config, paths.profile) : null;
      const nativeCliAgents = (cfg?.nativeCliAgents ?? []).filter(
        (agent: NativeCliAgentConfig) => agent.enabled !== false
      );
      await deliverProjectMessageToManagedNativeCliMembers({ session, nativeCliAgents, text, sender, exceptAgentName });
      return { accepted: true as const };
    },

    async notifyManagedNativeCliDirectMessage({
      sessionId,
      fromAgentName,
      to,
      text
    }: {
      sessionId: TranscriptTargetId;
      fromAgentName: string;
      to: string;
      text: string;
    }) {
      const session = requireTranscriptTarget(sessionId);
      const paths = ctx.deps.paths;
      const cfg = paths ? await loadAll(paths.config, paths.profile) : null;
      const nativeCliAgents = (cfg?.nativeCliAgents ?? []).filter(
        (agent: NativeCliAgentConfig) => agent.enabled !== false
      );
      await deliverDirectMessageToManagedNativeCliMember({ session, nativeCliAgents, fromAgentName, to, text });
      return { accepted: true as const };
    },

    async completeManagedNativeCliProjectMessage({
      sessionId,
      nativeCliSessionId,
      agentName,
      text,
      threadId,
      attachments
    }: {
      sessionId: TranscriptTargetId;
      nativeCliSessionId: string;
      agentName: string;
      text: string;
      threadId?: string;
      attachments?: MessageAttachmentRef[];
    }) {
      return completeManagedNativeCliThinking({
        sessionId,
        nativeCliSessionId,
        agentName,
        text,
        threadId,
        attachments
      });
    },

    async completeManagedNativeCliProviderMessage({
      sessionId,
      nativeCliSessionId,
      agentName,
      text,
      error,
      post = true
    }: {
      sessionId: TranscriptTargetId;
      nativeCliSessionId: string;
      agentName: string;
      text: string;
      error?: boolean;
      post?: boolean;
    }) {
      if (!post && !error) {
        const messageId = retireManagedNativeCliThinking(sessionId, nativeCliSessionId, agentName);
        return { messageId };
      }
      const completed = completeManagedNativeCliThinking({
        sessionId,
        nativeCliSessionId,
        agentName,
        text,
        source: 'native-cli-provider',
        error
      });
      return { messageId: completed.messageId };
    },

    async sendInline(
      { sessionId, text }: { sessionId: TranscriptTargetId } & SendMessageRequest,
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
      const session = requireTranscriptTarget(sessionId);
      assertWriteAllowed(session, runOpts?.transport ?? 'acp');
      if (runner && (await tryRunSessionCommand(runner, session, text, { sink, busy: aborts.has(sessionId) }))) return;
      // Out-of-band per-session runtime config (sandbox roots / session-scoped MCP tools / delegating
      // backends) set via configureRuntime — used when the caller doesn't pass explicit runOpts (the
      // ACP bridge proxies turns over HTTP and can't ship in-process backends, so it configures the
      // daemon out-of-band).
      const rt = runtimeForTranscriptTarget(sessionId);
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
          toolFilter: composeFilter(
            runOpts?.toolFilter ?? rt?.toolFilter,
            agentToolFilterForTranscriptTarget(sessionId)
          ),
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

    async generate({ sessionId, text }: { sessionId: TranscriptTargetId } & SendMessageRequest) {
      const session = requireTranscriptTarget(sessionId);
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
      const rt = runtimeForTranscriptTarget(sessionId);
      const loop = agent.loop(makeEmit(round), {
        modelOverride: session.model,
        sandboxRoots: sandboxRootsFor(sessionId, session.cwd, rt),
        defaultCwd: session.cwd,
        extraTools: rt?.extraTools,
        extraSkills: rt?.extraSkills,
        toolFilter: composeFilter(rt?.toolFilter, agentToolFilterForTranscriptTarget(sessionId))
      });
      try {
        const msg = await loop.runBlock(sessionId, text);
        log?.debug({ sessionId, event: 'session.generate.complete', text: msg.text }, 'session generate complete');
        const message: ChatMessage = {
          id: msg.id as ChatMessage['id'],
          transcriptTargetId: msg.transcriptTargetId as ChatMessage['transcriptTargetId'],
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
    forwardToNativeCli
  };
  return handlers;
}
