import type {
  IdempotencyKey,
  MessageAttachmentRef,
  MessageId,
  NativeAgentDirectMessage,
  SessionId
} from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';
import type { createManagedMeshAgentDelivery } from '#/handlers/session/handlers/managed-mesh-agent-delivery.ts';
import type { DirectMessageTarget } from '#/handlers/session/handlers/messaging-members.ts';
import type { ManagedMeshAgentProjectMessageSender } from '#/handlers/session/handlers/messaging-notices.ts';

import { extractError } from '#/agent/index.ts';
import { HandlerError } from '#/handlers/handler-error.ts';
import { resolveDirectMessageTarget } from '#/handlers/session/handlers/messaging-members.ts';
import { enabledInvitableMeshAgentConfigs } from '#/services/mesh-agent/invitable-agents.ts';

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
      exceptProjectMemberId,
      deliveryMode = 'queue'
    }: {
      sessionId: SessionId;
      text: string;
      sender?: ManagedMeshAgentProjectMessageSender;
      triggerMessageId?: MessageId;
      exceptProjectMemberId?: string;
      deliveryMode?: import('@monad/protocol').NativeAgentDeliveryMode;
    }) {
      const session = requireSession(sessionId);
      const cfg = ctx.deps.configManager?.get().cfg;
      const meshAgents = cfg ? enabledInvitableMeshAgentConfigs(cfg) : [];
      // Public project messages are room broadcasts. Mentions stay in the message body for each member
      // to interpret; they never narrow fanout or override the caller-selected queue/steer mode.
      void deliverProjectMessageToManagedMeshAgentMembers({
        session,
        meshAgents,
        text,
        sender,
        triggerMessageId,
        exceptProjectMemberId,
        deliveryMode
      }).catch((error) => {
        ctx.deps.log?.debug(
          {
            sessionId,
            error: extractError(error)
          },
          'managed native cli project notification failed'
        );
      });
      return { accepted: true as const };
    },

    // Direct-message addressing accepts only an exact canonical ProjectMember id in this session.
    resolveManagedMeshAgentDirectTarget({
      sessionId,
      target
    }: {
      sessionId: SessionId;
      target: string;
    }): DirectMessageTarget {
      const meshAgents = ctx.deps.configManager?.get().cfg.meshAgents ?? [];
      const member = resolveDirectMessageTarget(ctx.deps.store, sessionId, meshAgents, target);
      if (!member) {
        throw new HandlerError(
          'not_found',
          `Direct-message target "${target}" is not an active project member in this session`,
          'DIRECT_MESSAGE_TARGET_NOT_FOUND'
        );
      }
      return member;
    },

    async notifyManagedMeshAgentDirectMessage({
      message,
      noticeText,
      deliveryMode = 'queue'
    }: {
      message: NativeAgentDirectMessage;
      noticeText: string;
      deliveryMode?: import('@monad/protocol').NativeAgentDeliveryMode;
    }) {
      const session = requireSession(message.sessionId);
      const cfg = ctx.deps.configManager?.get().cfg;
      const meshAgents = cfg ? enabledInvitableMeshAgentConfigs(cfg) : [];
      const fromAgentName = message.fromAgent;
      if (!fromAgentName) return { accepted: true as const };
      await deliverDirectMessageToManagedMeshAgentMember({
        session,
        meshAgents,
        message,
        noticeText,
        deliveryMode
      });
      return { accepted: true as const };
    },

    async completeManagedMeshAgentProjectMessage({
      sessionId,
      meshSessionId,
      projectMemberId,
      text,
      replyToMessageId,
      attachments,
      idempotencyKey,
      placeholderRemovalIdempotencyKey
    }: {
      sessionId: SessionId;
      meshSessionId: string;
      projectMemberId: string;
      text: string;
      replyToMessageId?: MessageId;
      attachments?: MessageAttachmentRef[];
      idempotencyKey: IdempotencyKey;
      placeholderRemovalIdempotencyKey: IdempotencyKey;
    }) {
      return completeManagedMeshAgentThinking({
        sessionId,
        meshSessionId,
        agentName: projectMemberId,
        text,
        replyToMessageId,
        attachments,
        idempotencyKey,
        placeholderRemovalIdempotencyKey
      });
    },

    async completeManagedMeshAgentProviderMessage({
      sessionId,
      meshSessionId,
      projectMemberId,
      text,
      error,
      post = true
    }: {
      sessionId: SessionId;
      meshSessionId: string;
      projectMemberId: string;
      text: string;
      error?: boolean;
      post?: boolean;
    }) {
      if (!post && !error) {
        const messageId = await retireManagedMeshAgentThinking(sessionId, meshSessionId, projectMemberId);
        return { messageId };
      }
      const completed = await completeManagedMeshAgentThinking({
        sessionId,
        meshSessionId,
        agentName: projectMemberId,
        text,
        source: 'mesh-agent-provider',
        error,
        settleTurn: true
      });
      return { messageId: completed.messageId };
    }
  };
}
