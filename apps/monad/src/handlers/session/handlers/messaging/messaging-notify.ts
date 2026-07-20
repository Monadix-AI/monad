import type { MessageAttachmentRef, MessageId, NativeAgentDirectMessage, SessionId } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';
import type { createManagedMeshAgentDelivery } from '#/handlers/session/handlers/managed-mesh-agent-delivery.ts';
import type { ManagedMeshAgentProjectMessageSender } from '#/handlers/session/handlers/messaging-notices.ts';

import {
  meshAgentProjectMemberDisplayName,
  meshAgentProjectMemberDisplayNameForAgent,
  meshAgentProjectMemberRuntimeName,
  workplaceProjectMembers
} from '#/handlers/session/handlers/messaging-members.ts';
import { normalizeManagedMeshAgentDirectTarget } from '#/handlers/session/handlers/messaging-notices.ts';
import { messageIdempotencyKey } from '#/services/messages/ingress.ts';

/** Wraps the managed-mesh-agent delivery primitives with the project-config lookups the
 *  session handlers need (loading enabled agents, resolving the transcript target). */
export function createMessagingNotifyHandlers(
  ctx: SessionContext,
  managedMeshAgentDelivery: ReturnType<typeof createManagedMeshAgentDelivery>
) {
  const {
    deps: { store },
    messageIngress,
    requireSession
  } = ctx;
  const {
    completeManagedMeshAgentThinking,
    retireManagedMeshAgentThinking,
    deliverProjectMessageToManagedMeshAgentMembers,
    deliverDirectMessageToManagedMeshAgentMember
  } = managedMeshAgentDelivery;

  return {
    async notifyManagedMeshAgentProjectMembers({
      sessionId,
      text,
      sender,
      triggerMessageId,
      exceptAgentName
    }: {
      sessionId: SessionId;
      text: string;
      sender?: ManagedMeshAgentProjectMessageSender;
      triggerMessageId?: MessageId;
      exceptAgentName?: string;
    }) {
      const session = requireSession(sessionId);
      const meshAgents = ctx.deps.configManager?.get().cfg.meshAgents ?? [];
      await deliverProjectMessageToManagedMeshAgentMembers({
        session,
        meshAgents,
        text,
        sender,
        triggerMessageId,
        exceptAgentName
      });
      return { accepted: true as const };
    },

    async notifyManagedMeshAgentDirectMessage({
      message,
      noticeText
    }: {
      message: NativeAgentDirectMessage;
      noticeText: string;
    }) {
      const session = requireSession(message.sessionId);
      const meshAgents = ctx.deps.configManager?.get().cfg.meshAgents ?? [];
      const fromAgentName = message.fromAgent;
      if (!fromAgentName) return { accepted: true as const };
      const to = normalizeManagedMeshAgentDirectTarget(message.peer);
      const recipient = workplaceProjectMembers(store, message.sessionId).find(
        (member) => member.type === 'mesh-agent' && meshAgentProjectMemberRuntimeName(member) === to
      );
      if (recipient && to !== fromAgentName) {
        const fromDisplayName = meshAgentProjectMemberDisplayNameForAgent(store, message.sessionId, fromAgentName);
        const toDisplayName = meshAgentProjectMemberDisplayName(recipient);
        // DM content is participant-only: it lives in native_agent_direct_messages and reaches
        // only the two participants' own provider context. The public session transcript gets
        // the identity/timing envelope only — never the body or its attachments.
        const { text: _text, attachments: _attachments, ...envelope } = message;
        await messageIngress.deliver({
          transcriptTargetId: message.sessionId,
          idempotencyKey: messageIdempotencyKey('native-agent-direct-message', message.id),
          producer: { kind: 'system', subsystem: 'managed-mesh-agent' },
          role: 'assistant',
          type: 'mesh_agent_direct_message',
          text: `${fromDisplayName} sent ${toDisplayName} a DM.`,
          data: { message: { ...envelope, text: '' } }
        });
      }
      await deliverDirectMessageToManagedMeshAgentMember({
        session,
        meshAgents,
        fromAgentName,
        to,
        text: noticeText
      });
      return { accepted: true as const };
    },

    async completeManagedMeshAgentProjectMessage({
      sessionId,
      meshSessionId,
      agentName,
      text,
      threadId,
      attachments
    }: {
      sessionId: SessionId;
      meshSessionId: string;
      agentName: string;
      text: string;
      threadId?: string;
      attachments?: MessageAttachmentRef[];
    }) {
      return completeManagedMeshAgentThinking({
        sessionId,
        meshSessionId,
        agentName,
        text,
        threadId,
        attachments
      });
    },

    async completeManagedMeshAgentProviderMessage({
      sessionId,
      meshSessionId,
      agentName,
      text,
      error,
      post = true
    }: {
      sessionId: SessionId;
      meshSessionId: string;
      agentName: string;
      text: string;
      error?: boolean;
      post?: boolean;
    }) {
      if (!post && !error) {
        const messageId = await retireManagedMeshAgentThinking(sessionId, meshSessionId, agentName);
        return { messageId };
      }
      const completed = await completeManagedMeshAgentThinking({
        sessionId,
        meshSessionId,
        agentName,
        text,
        source: 'mesh-agent-provider',
        error,
        settleTurn: true
      });
      return { messageId: completed.messageId };
    }
  };
}
