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
import { routeChannelMessage } from '#/handlers/session/channel-routing.ts';
import {
  AMBIGUOUS_MEMBER_TARGET_CODE,
  AmbiguousMemberTargetError,
  managedMeshAgentProjectMembers,
  resolveDirectMessageTarget,
  resolveManagedMember
} from '#/handlers/session/handlers/messaging-members.ts';
import { enabledInvitableMeshAgentConfigs } from '#/services/mesh-agent/invitable-agents.ts';

/** Wraps the managed-mesh-agent delivery primitives with the project-config lookups the
 *  session handlers need (loading enabled agents, resolving the transcript target). */
export function createMessagingNotifyHandlers(
  ctx: SessionContext,
  managedMeshAgentDelivery: ReturnType<typeof createManagedMeshAgentDelivery>
) {
  const {
    deps: { store },
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
      exceptProjectMemberId
    }: {
      sessionId: SessionId;
      text: string;
      sender?: ManagedMeshAgentProjectMessageSender;
      triggerMessageId?: MessageId;
      exceptProjectMemberId?: string;
    }) {
      const session = requireSession(sessionId);
      const cfg = ctx.deps.configManager?.get().cfg;
      const meshAgents = cfg ? enabledInvitableMeshAgentConfigs(cfg) : [];
      let onlyProjectMemberId: string | undefined;
      if (sender?.kind === 'mesh-agent') {
        const managedMembers = managedMeshAgentProjectMembers(store, sessionId, meshAgents);
        const route = routeChannelMessage({
          text,
          acpAgentNames: [],
          meshAgentNames: managedMembers.flatMap((member) => [
            member.projectMemberId,
            member.runtimeAgentName,
            member.templateAgentName,
            member.displayName
          ])
        });
        if (route.kind !== 'forward-mesh-agent') return { accepted: true as const };
        onlyProjectMemberId = resolveManagedMember(managedMembers, route.agentName)?.projectMemberId;
      }
      void deliverProjectMessageToManagedMeshAgentMembers({
        session,
        meshAgents,
        text,
        sender,
        triggerMessageId,
        exceptProjectMemberId,
        ...(onlyProjectMemberId ? { onlyProjectMemberId } : {})
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

    // Boundary classifier for direct-message addressing: a `to`/`with` string becomes either a canonical
    // member (pmid, delivery-eligible) or a verbatim private label (ledger-only). Callers branch on kind.
    resolveManagedMeshAgentDirectTarget({
      sessionId,
      target
    }: {
      sessionId: SessionId;
      target: string;
    }): DirectMessageTarget {
      const meshAgents = ctx.deps.configManager?.get().cfg.meshAgents ?? [];
      try {
        return resolveDirectMessageTarget(ctx.deps.store, sessionId, meshAgents, target);
      } catch (err) {
        // The resolver stays presentation-agnostic; the handler maps its typed ambiguity to a stable
        // conflict so a shared alias surfaces as 409 AMBIGUOUS_MEMBER_TARGET, never an opaque 500.
        if (err instanceof AmbiguousMemberTargetError) {
          throw new HandlerError('conflict', err.message, AMBIGUOUS_MEMBER_TARGET_CODE);
        }
        throw err;
      }
    },

    async notifyManagedMeshAgentDirectMessage({
      message,
      noticeText
    }: {
      message: NativeAgentDirectMessage;
      noticeText: string;
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
        noticeText
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
