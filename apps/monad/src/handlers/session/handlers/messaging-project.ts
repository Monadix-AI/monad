import type { AcpAgentConfig, NativeCliAgentConfig } from '@monad/home';
import type { SendMessageRequest, SendMessageResponse, SessionMcpServer, TranscriptTargetId } from '@monad/protocol';
import type { ChannelParticipant } from '@/agent/prompts/channel.ts';
import type { SessionContext } from '@/handlers/session/context.ts';
import type { createAcpChannelDelegation } from '@/handlers/session/handlers/acp-channel-delegation.ts';
import type { createForwardAcpHandler } from '@/handlers/session/handlers/forward-acp.ts';
import type { createForwardNativeCliHandler } from '@/handlers/session/handlers/forward-native-cli.ts';
import type { createManagedNativeCliDelivery } from '@/handlers/session/handlers/managed-native-cli-delivery.ts';

import { loadAll } from '@monad/home';

import { buildChannelTurnContext } from '@/agent/prompts/channel.ts';
import {
  CHANNEL_HOST_EXT_KEY,
  normalizeChannelModeratorId,
  routeChannelMessage
} from '@/handlers/session/channel-routing.ts';
import {
  channelDelegateMcpServers,
  isWorkplaceProjectTarget,
  nativeCliProjectMemberDisplayName,
  nativeCliProjectMemberRuntimeName,
  nativeCliProjectMemberTemplateName,
  workplaceProjectMembers
} from '@/handlers/session/handlers/messaging-members.ts';

type SendHandler = (
  args: { sessionId: TranscriptTargetId; onComplete?: (text: string) => void | Promise<void> } & SendMessageRequest
) => Promise<SendMessageResponse>;

export interface SendProjectMessageDeps {
  send: SendHandler;
  forwardToAcp: ReturnType<typeof createForwardAcpHandler>;
  forwardToNativeCli: ReturnType<typeof createForwardNativeCliHandler>;
  deliverProjectMessageToAcpMembers: ReturnType<typeof createAcpChannelDelegation>['deliverProjectMessageToAcpMembers'];
  dispatchChannelNextTargets: ReturnType<typeof createAcpChannelDelegation>['dispatchChannelNextTargets'];
  deliverProjectMessageToManagedNativeCliMembers: ReturnType<
    typeof createManagedNativeCliDelivery
  >['deliverProjectMessageToManagedNativeCliMembers'];
  runtimeForTranscriptTarget: (
    sessionId: TranscriptTargetId
  ) => { mcpServers?: readonly SessionMcpServer[] } | undefined;
}

/** Routes an inbound channel/project message to the right recipient — the session's bound agent,
 *  a moderator, a direct ACP/native-CLI target, or a project-wide fan-out — and wires up the
 *  channel `next`-target dispatch once the turn completes. */
export function createSendProjectMessageHandler(ctx: SessionContext, deps: SendProjectMessageDeps) {
  const { requireTranscriptTarget } = ctx;
  const {
    send,
    forwardToAcp,
    forwardToNativeCli,
    deliverProjectMessageToAcpMembers,
    dispatchChannelNextTargets,
    deliverProjectMessageToManagedNativeCliMembers,
    runtimeForTranscriptTarget
  } = deps;

  async function sendProjectMessage({ sessionId, text }: { sessionId: TranscriptTargetId; text: string }) {
    const session = requireTranscriptTarget(sessionId);
    const paths = ctx.deps.paths;
    const cfg = paths ? await loadAll(paths.config, paths.profile) : null;
    const acpAgents = (cfg?.acpAgents ?? []).filter((agent: AcpAgentConfig) => agent.enabled !== false);
    const nativeCliAgents = (cfg?.nativeCliAgents ?? []).filter(
      (agent: NativeCliAgentConfig) => agent.enabled !== false
    );
    const isWorkplaceProject = isWorkplaceProjectTarget(session);
    const projectMembers = isWorkplaceProject ? workplaceProjectMembers(session) : [];
    const projectAcpAgentNames = projectMembers.filter((member) => member.type === 'acp').map((member) => member.name);
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
    ctx.deps.log?.debug(
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
          ? await send({
              sessionId,
              text: route.text,
              ambientContext: publicAmbientContext
            })
          : await send({ sessionId, text: route.text, generate: false });
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
      const result = await send({
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
      return forwardToNativeCli({
        sessionId,
        agentName: route.agentName,
        text: route.text,
        displayText: route.displayText
      });
    return forwardToAcp({
      sessionId,
      agentName: route.agentName,
      text: route.text,
      displayText: route.displayText,
      ambientContext,
      onComplete: dispatchStructuredNext
    });
  }

  async function sendChannelMessage({ sessionId, text }: { sessionId: TranscriptTargetId; text: string }) {
    return sendProjectMessage({ sessionId, text });
  }

  return { sendProjectMessage, sendChannelMessage };
}
