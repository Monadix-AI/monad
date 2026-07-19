import type { MeshAgentConfig } from '@monad/environment';
import type { MessageAttachmentRef, MessageId, SessionId } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';
import type { createManagedMeshAgentDelivery } from '#/handlers/session/handlers/managed-mesh-agent-delivery.ts';
import type { ManagedMeshAgentProjectMessageSender } from '#/handlers/session/handlers/messaging-notices.ts';

/** Wraps the managed-mesh-agent delivery primitives with the project-config lookups the
 *  session handlers need (loading enabled agents, resolving the transcript target). */
export function createMessagingNotifyHandlers(
  ctx: SessionContext,
  managedMeshAgentDelivery: ReturnType<typeof createManagedMeshAgentDelivery>
) {
  const { requireSession } = ctx;
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
      const meshAgents = (ctx.deps.configManager?.get().cfg.meshAgents ?? []).filter(
        (agent: MeshAgentConfig) => agent.enabled !== false
      );
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
      sessionId,
      fromAgentName,
      to,
      text
    }: {
      sessionId: SessionId;
      fromAgentName: string;
      to: string;
      text: string;
    }) {
      const session = requireSession(sessionId);
      const meshAgents = (ctx.deps.configManager?.get().cfg.meshAgents ?? []).filter(
        (agent: MeshAgentConfig) => agent.enabled !== false
      );
      await deliverDirectMessageToManagedMeshAgentMember({ session, meshAgents, fromAgentName, to, text });
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
        error
      });
      return { messageId: completed.messageId };
    }
  };
}
