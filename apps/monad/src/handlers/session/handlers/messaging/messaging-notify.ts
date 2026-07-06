import type { NativeCliAgentConfig } from '@monad/home';
import type { MessageAttachmentRef, TranscriptTargetId } from '@monad/protocol';
import type { SessionContext } from '@/handlers/session/context.ts';
import type { createManagedNativeCliDelivery } from '@/handlers/session/handlers/managed-native-cli-delivery.ts';
import type { ManagedNativeCliProjectMessageSender } from '@/handlers/session/handlers/messaging-notices.ts';

import { loadAll } from '@monad/home';

/** Wraps the managed-native-cli delivery primitives with the project-config lookups the
 *  session handlers need (loading enabled agents, resolving the transcript target). */
export function createMessagingNotifyHandlers(
  ctx: SessionContext,
  managedNativeCliDelivery: ReturnType<typeof createManagedNativeCliDelivery>
) {
  const { requireTranscriptTarget } = ctx;
  const {
    completeManagedNativeCliThinking,
    retireManagedNativeCliThinking,
    deliverProjectMessageToManagedNativeCliMembers,
    deliverDirectMessageToManagedNativeCliMember
  } = managedNativeCliDelivery;

  return {
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
    }
  };
}
