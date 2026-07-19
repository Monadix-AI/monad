import type { ExternalAgentConfig } from '@monad/environment';
import type { MessageAttachmentRef, MessageId, SessionId } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';
import type { createManagedExternalAgentDelivery } from '#/handlers/session/handlers/managed-external-agent-delivery.ts';
import type { ManagedExternalAgentProjectMessageSender } from '#/handlers/session/handlers/messaging-notices.ts';

/** Wraps the managed-external-agent delivery primitives with the project-config lookups the
 *  session handlers need (loading enabled agents, resolving the transcript target). */
export function createMessagingNotifyHandlers(
  ctx: SessionContext,
  managedExternalAgentDelivery: ReturnType<typeof createManagedExternalAgentDelivery>
) {
  const { requireSession } = ctx;
  const {
    completeManagedExternalAgentThinking,
    retireManagedExternalAgentThinking,
    deliverProjectMessageToManagedExternalAgentMembers,
    deliverDirectMessageToManagedExternalAgentMember
  } = managedExternalAgentDelivery;

  return {
    async notifyManagedExternalAgentProjectMembers({
      sessionId,
      text,
      sender,
      triggerMessageId,
      exceptAgentName
    }: {
      sessionId: SessionId;
      text: string;
      sender?: ManagedExternalAgentProjectMessageSender;
      triggerMessageId?: MessageId;
      exceptAgentName?: string;
    }) {
      const session = requireSession(sessionId);
      const externalAgents = (ctx.deps.configManager?.get().cfg.externalAgents ?? []).filter(
        (agent: ExternalAgentConfig) => agent.enabled !== false
      );
      await deliverProjectMessageToManagedExternalAgentMembers({
        session,
        externalAgents,
        text,
        sender,
        triggerMessageId,
        exceptAgentName
      });
      return { accepted: true as const };
    },

    async notifyManagedExternalAgentDirectMessage({
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
      const externalAgents = (ctx.deps.configManager?.get().cfg.externalAgents ?? []).filter(
        (agent: ExternalAgentConfig) => agent.enabled !== false
      );
      await deliverDirectMessageToManagedExternalAgentMember({ session, externalAgents, fromAgentName, to, text });
      return { accepted: true as const };
    },

    async completeManagedExternalAgentProjectMessage({
      sessionId,
      externalAgentSessionId,
      agentName,
      text,
      threadId,
      attachments
    }: {
      sessionId: SessionId;
      externalAgentSessionId: string;
      agentName: string;
      text: string;
      threadId?: string;
      attachments?: MessageAttachmentRef[];
    }) {
      return completeManagedExternalAgentThinking({
        sessionId,
        externalAgentSessionId,
        agentName,
        text,
        threadId,
        attachments
      });
    },

    async completeManagedExternalAgentProviderMessage({
      sessionId,
      externalAgentSessionId,
      agentName,
      text,
      error,
      post = true
    }: {
      sessionId: SessionId;
      externalAgentSessionId: string;
      agentName: string;
      text: string;
      error?: boolean;
      post?: boolean;
    }) {
      if (!post && !error) {
        const messageId = await retireManagedExternalAgentThinking(sessionId, externalAgentSessionId, agentName);
        return { messageId };
      }
      const completed = await completeManagedExternalAgentThinking({
        sessionId,
        externalAgentSessionId,
        agentName,
        text,
        source: 'external-agent-provider',
        error
      });
      return { messageId: completed.messageId };
    }
  };
}
