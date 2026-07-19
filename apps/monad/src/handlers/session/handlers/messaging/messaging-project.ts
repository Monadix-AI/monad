import type { AcpAgentConfig, MeshAgentConfig } from '@monad/environment';
import type {
  SendMessageAttachment,
  SendMessageRequest,
  SendMessageResponse,
  SessionId,
  SessionMcpServer
} from '@monad/protocol';
import type { BuildChannelContextInput, ChannelParticipant } from '#/agent/prompts/channel.ts';
import type { SessionContext } from '#/handlers/session/context.ts';
import type { createAcpChannelDelegation } from '#/handlers/session/handlers/acp-channel-delegation.ts';
import type { createForwardAcpHandler } from '#/handlers/session/handlers/forward-acp.ts';
import type { createForwardMeshAgentHandler } from '#/handlers/session/handlers/forward-mesh-agent.ts';
import type { createManagedMeshAgentDelivery } from '#/handlers/session/handlers/managed-mesh-agent-delivery.ts';

import { buildChannelTurnContext } from '#/agent/prompts/channel.ts';
import { routeChannelMessage } from '#/handlers/session/channel-routing.ts';
import { messageTextWithAttachments } from '#/handlers/session/handlers/messaging-attachments.ts';
import {
  channelDelegateMcpServers,
  isWorkplaceProjectTarget,
  meshAgentProjectMemberDisplayName,
  meshAgentProjectMemberRuntimeName,
  meshAgentProjectMemberTemplateName,
  workplaceProjectMembers
} from '#/handlers/session/handlers/messaging-members.ts';

type SendHandler = (
  args: { sessionId: SessionId; onComplete?: (text: string) => void | Promise<void> } & SendMessageRequest
) => Promise<SendMessageResponse>;

export interface SendProjectMessageDeps {
  send: SendHandler;
  forwardToAcp: ReturnType<typeof createForwardAcpHandler>;
  forwardToMeshAgent: ReturnType<typeof createForwardMeshAgentHandler>;
  deliverProjectMessageToAcpMembers: ReturnType<typeof createAcpChannelDelegation>['deliverProjectMessageToAcpMembers'];
  dispatchChannelNextTargets: ReturnType<typeof createAcpChannelDelegation>['dispatchChannelNextTargets'];
  deliverProjectMessageToManagedMeshAgentMembers: ReturnType<
    typeof createManagedMeshAgentDelivery
  >['deliverProjectMessageToManagedMeshAgentMembers'];
  runtimeForSession: (sessionId: SessionId) => { mcpServers?: readonly SessionMcpServer[] } | undefined;
}

/** Routes an inbound channel/project message to the right recipient — the session's bound agent,
 *  a direct ACP/MeshAgent target, or a project-wide fan-out — and wires up the
 *  channel `next`-target dispatch once the turn completes. */
export function createSendProjectMessageHandler(ctx: SessionContext, deps: SendProjectMessageDeps) {
  const {
    requireSession,
    deps: { store }
  } = ctx;
  const {
    send,
    forwardToAcp,
    forwardToMeshAgent,
    deliverProjectMessageToAcpMembers,
    dispatchChannelNextTargets,
    deliverProjectMessageToManagedMeshAgentMembers,
    runtimeForSession
  } = deps;

  async function sendProjectMessage({
    sessionId,
    text,
    attachments
  }: {
    sessionId: SessionId;
    text: string;
    attachments?: SendMessageAttachment[];
  }) {
    const routeSeedText = text.trim() || (attachments?.length ? 'Shared attachments.' : '');
    const session = requireSession(sessionId);
    const cfg = ctx.deps.configManager?.get().cfg;
    const acpAgents = (cfg?.acpAgents ?? []).filter((agent: AcpAgentConfig) => agent.enabled !== false);
    const meshAgents = (cfg?.meshAgents ?? []).filter((agent: MeshAgentConfig) => agent.enabled !== false);
    const isWorkplaceProject = isWorkplaceProjectTarget(session);
    const projectMembers = isWorkplaceProject ? workplaceProjectMembers(store, session.id) : [];
    const projectAcpAgentNames = projectMembers.filter((member) => member.type === 'acp').map((member) => member.name);
    const projectMeshAgentNames = projectMembers
      .filter((member) => member.type === 'mesh-agent')
      .map((member) => meshAgentProjectMemberRuntimeName(member));
    const hasMonadMember = projectMembers.some((member) => member.type === 'monad');
    const route = routeChannelMessage({
      text: routeSeedText,
      acpAgentNames: isWorkplaceProject ? projectAcpAgentNames : acpAgents.map((agent: AcpAgentConfig) => agent.name),
      meshAgentNames: isWorkplaceProject
        ? projectMeshAgentNames
        : meshAgents.map((agent: MeshAgentConfig) => agent.name)
    });
    if (route.kind === 'none') return { accepted: true as const };
    ctx.deps.log?.debug(
      {
        sessionId,
        transcriptTargetId: sessionId,
        event: 'project.message.route',
        text: routeSeedText,
        route
      },
      'project message route'
    );
    const responseMode = route.direct ? 'direct_structured' : 'worker_plain';
    const studioAgents = cfg?.agent.agents ?? [];
    const meshAgentParticipants: ChannelParticipant[] = isWorkplaceProject
      ? projectMembers
          .filter((member) => member.type === 'mesh-agent')
          .map((member) => {
            const templateName = meshAgentProjectMemberTemplateName(member);
            return {
              id: `mesh-agent:${meshAgentProjectMemberRuntimeName(member)}`,
              name: meshAgentProjectMemberDisplayName(member),
              kind: 'mesh-agent' as const,
              description: `template:${templateName}`
            };
          })
      : meshAgents.map((agent: MeshAgentConfig) => ({
          id: `mesh-agent:${agent.name}`,
          name: agent.name,
          kind: 'mesh-agent' as const
        }));
    const participants: ChannelParticipant[] = [
      { id: 'human', name: cfg?.user.displayName ?? 'User', kind: 'human' },
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
      ...meshAgentParticipants
    ];
    const channelPromptInput: BuildChannelContextInput | undefined =
      route.kind === 'send' && route.generate === false
        ? undefined
        : {
            channelId: session.title,
            sessionId,
            routeKind: route.kind,
            targetName: route.kind === 'forward-acp' ? route.agentName : 'monad',
            responseMode,
            participants,
            targetMention: route.targetMention
          };
    const ambientContext = channelPromptInput ? buildChannelTurnContext(channelPromptInput) : undefined;
    const mcpServers = channelDelegateMcpServers(cfg?.mcpServers, runtimeForSession(sessionId)?.mcpServers);
    const isPublicProjectFanout = isWorkplaceProject && route.kind === 'send' && !route.direct;
    const publicChannelPromptInput: BuildChannelContextInput = {
      channelId: session.title,
      sessionId,
      routeKind: route.kind,
      targetName: 'project members',
      responseMode,
      participants,
      targetMention: route.targetMention
    };
    const publicAmbientContext = buildChannelTurnContext(publicChannelPromptInput);
    const dispatchStructuredNext =
      ambientContext && channelPromptInput && responseMode === 'direct_structured'
        ? (responseText: string) =>
            dispatchChannelNextTargets({
              sessionId,
              responseText,
              channelPromptInput,
              acpAgents,
              mcpServers
            })
        : undefined;
    if (route.kind === 'send') {
      if (isPublicProjectFanout) {
        const shouldRunMonad = hasMonadMember;
        const result = shouldRunMonad
          ? await send({
              sessionId,
              text: route.text,
              attachments,
              ambientContext: publicAmbientContext
            })
          : await send({ sessionId, text: route.text, attachments, generate: false });
        const humanSender = { kind: 'human' as const, name: cfg?.user.displayName ?? 'User', id: 'human' };
        await Promise.all([
          deliverProjectMessageToManagedMeshAgentMembers({
            session,
            meshAgents,
            text: messageTextWithAttachments(route.text, attachments),
            sender: humanSender
          }),
          deliverProjectMessageToAcpMembers({
            session,
            acpAgents,
            mcpServers: cfg?.mcpServers,
            text: messageTextWithAttachments(route.text, attachments),
            channelPromptInput: publicChannelPromptInput
          })
        ]);
        return result;
      }
      const routeGenerate = !isWorkplaceProject ? route.generate : hasMonadMember ? route.generate : false;
      const result = await send({
        sessionId,
        text: route.text,
        attachments,
        generate: routeGenerate,
        ambientContext,
        onComplete: dispatchStructuredNext
      });
      if (!route.direct && route.generate === false) {
        await deliverProjectMessageToManagedMeshAgentMembers({
          session,
          meshAgents,
          text: messageTextWithAttachments(route.text, attachments),
          sender: { kind: 'human', name: cfg?.user.displayName ?? 'User', id: 'human' }
        });
      }
      return result;
    }
    if (route.kind === 'forward-mesh-agent')
      return forwardToMeshAgent({
        sessionId,
        agentName: route.agentName,
        text: messageTextWithAttachments(route.text, attachments),
        displayText: route.displayText
      });
    return forwardToAcp({
      sessionId,
      agentName: route.agentName,
      text: messageTextWithAttachments(route.text, attachments),
      displayText: route.displayText,
      ambientContext,
      channelPromptInput,
      onComplete: dispatchStructuredNext
    });
  }

  async function sendChannelMessage({
    sessionId,
    text,
    attachments
  }: {
    sessionId: SessionId;
    text: string;
    attachments?: SendMessageAttachment[];
  }) {
    return sendProjectMessage({ sessionId, text, attachments });
  }

  return { sendProjectMessage, sendChannelMessage };
}
