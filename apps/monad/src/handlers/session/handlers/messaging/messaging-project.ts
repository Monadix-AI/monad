import type { AcpAgentConfig, ExternalAgentConfig } from '@monad/home';
import type {
  SendMessageAttachment,
  SendMessageRequest,
  SendMessageResponse,
  SessionId,
  SessionMcpServer
} from '@monad/protocol';
import type { ChannelParticipant } from '#/agent/prompts/channel.ts';
import type { SessionContext } from '#/handlers/session/context.ts';
import type { createAcpChannelDelegation } from '#/handlers/session/handlers/acp-channel-delegation.ts';
import type { createForwardAcpHandler } from '#/handlers/session/handlers/forward-acp.ts';
import type { createForwardExternalAgentHandler } from '#/handlers/session/handlers/forward-external-agent.ts';
import type { createManagedExternalAgentDelivery } from '#/handlers/session/handlers/managed-external-agent-delivery.ts';

import { loadAll } from '@monad/home';

import { buildChannelTurnContext } from '#/agent/prompts/channel.ts';
import { routeChannelMessage } from '#/handlers/session/channel-routing.ts';
import { messageTextWithAttachments } from '#/handlers/session/handlers/messaging-attachments.ts';
import {
  channelDelegateMcpServers,
  externalAgentProjectMemberDisplayName,
  externalAgentProjectMemberRuntimeName,
  externalAgentProjectMemberTemplateName,
  isWorkplaceProjectTarget,
  workplaceProjectMembers
} from '#/handlers/session/handlers/messaging-members.ts';

type SendHandler = (
  args: { sessionId: SessionId; onComplete?: (text: string) => void | Promise<void> } & SendMessageRequest
) => Promise<SendMessageResponse>;

export interface SendProjectMessageDeps {
  send: SendHandler;
  forwardToAcp: ReturnType<typeof createForwardAcpHandler>;
  forwardToExternalAgent: ReturnType<typeof createForwardExternalAgentHandler>;
  deliverProjectMessageToAcpMembers: ReturnType<typeof createAcpChannelDelegation>['deliverProjectMessageToAcpMembers'];
  dispatchChannelNextTargets: ReturnType<typeof createAcpChannelDelegation>['dispatchChannelNextTargets'];
  deliverProjectMessageToManagedExternalAgentMembers: ReturnType<
    typeof createManagedExternalAgentDelivery
  >['deliverProjectMessageToManagedExternalAgentMembers'];
  runtimeForSession: (sessionId: SessionId) => { mcpServers?: readonly SessionMcpServer[] } | undefined;
}

/** Routes an inbound channel/project message to the right recipient — the session's bound agent,
 *  a direct ACP/external agent target, or a project-wide fan-out — and wires up the
 *  channel `next`-target dispatch once the turn completes. */
export function createSendProjectMessageHandler(ctx: SessionContext, deps: SendProjectMessageDeps) {
  const {
    requireSession,
    deps: { store }
  } = ctx;
  const {
    send,
    forwardToAcp,
    forwardToExternalAgent,
    deliverProjectMessageToAcpMembers,
    dispatchChannelNextTargets,
    deliverProjectMessageToManagedExternalAgentMembers,
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
    const paths = ctx.deps.paths;
    const cfg = paths ? await loadAll(paths.config, paths.profile) : null;
    const acpAgents = (cfg?.acpAgents ?? []).filter((agent: AcpAgentConfig) => agent.enabled !== false);
    const externalAgents = (cfg?.externalAgents ?? []).filter((agent: ExternalAgentConfig) => agent.enabled !== false);
    const isWorkplaceProject = isWorkplaceProjectTarget(session);
    const projectMembers = isWorkplaceProject ? workplaceProjectMembers(store, session.id) : [];
    const projectAcpAgentNames = projectMembers.filter((member) => member.type === 'acp').map((member) => member.name);
    const projectExternalAgentNames = projectMembers
      .filter((member) => member.type === 'external-agent')
      .map((member) => externalAgentProjectMemberRuntimeName(member));
    const hasMonadMember = projectMembers.some((member) => member.type === 'monad');
    const route = routeChannelMessage({
      text: routeSeedText,
      acpAgentNames: isWorkplaceProject ? projectAcpAgentNames : acpAgents.map((agent: AcpAgentConfig) => agent.name),
      externalAgentNames: isWorkplaceProject
        ? projectExternalAgentNames
        : externalAgents.map((agent: ExternalAgentConfig) => agent.name)
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
    const externalAgentParticipants: ChannelParticipant[] = isWorkplaceProject
      ? projectMembers
          .filter((member) => member.type === 'external-agent')
          .map((member) => {
            const templateName = externalAgentProjectMemberTemplateName(member);
            return {
              id: `external-agent:${externalAgentProjectMemberRuntimeName(member)}`,
              name: externalAgentProjectMemberDisplayName(member),
              kind: 'external-agent' as const,
              description: `template:${templateName}`
            };
          })
      : externalAgents.map((agent: ExternalAgentConfig) => ({
          id: `external-agent:${agent.name}`,
          name: agent.name,
          kind: 'external-agent' as const
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
      ...externalAgentParticipants
    ];
    const ambientContext =
      route.kind === 'send' && route.generate === false
        ? undefined
        : buildChannelTurnContext({
            channelId: session.title,
            sessionId,
            routeKind: route.kind,
            targetName: route.kind === 'forward-acp' ? route.agentName : 'monad',
            responseMode,
            participants,
            targetMention: route.targetMention
          });
    const mcpServers = channelDelegateMcpServers(cfg?.mcpServers, runtimeForSession(sessionId)?.mcpServers);
    const isPublicProjectFanout = isWorkplaceProject && route.kind === 'send' && !route.direct;
    const publicAmbientContext = buildChannelTurnContext({
      channelId: session.title,
      sessionId,
      routeKind: route.kind,
      targetName: 'project members',
      responseMode,
      participants,
      targetMention: route.targetMention
    });
    const dispatchStructuredNext =
      ambientContext && responseMode === 'direct_structured'
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
        const shouldRunMonad = hasMonadMember;
        const result = shouldRunMonad
          ? await send({
              sessionId,
              text: route.text,
              attachments,
              ambientContext: publicAmbientContext
            })
          : await send({ sessionId, text: route.text, attachments, generate: false });
        const humanSender = { kind: 'human' as const, name: cfg?.principal.displayName ?? 'User', id: 'human' };
        await Promise.all([
          deliverProjectMessageToManagedExternalAgentMembers({
            session,
            externalAgents,
            text: messageTextWithAttachments(route.text, attachments),
            sender: humanSender
          }),
          deliverProjectMessageToAcpMembers({
            session,
            acpAgents,
            mcpServers: cfg?.mcpServers,
            text: messageTextWithAttachments(route.text, attachments),
            ambientContext: publicAmbientContext
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
        await deliverProjectMessageToManagedExternalAgentMembers({
          session,
          externalAgents,
          text: messageTextWithAttachments(route.text, attachments),
          sender: { kind: 'human', name: cfg?.principal.displayName ?? 'User', id: 'human' }
        });
      }
      return result;
    }
    if (route.kind === 'forward-external-agent')
      return forwardToExternalAgent({
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
