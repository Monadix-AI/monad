import type {
  NativeAgentDirectMessage,
  NativeAgentReadRequest,
  NativeAgentReadResponse,
  NativeAgentSendRequest,
  NativeAgentSendResponse,
  ProjectId
} from '@monad/protocol';
import type { createDaemonHandlers } from '@/handlers/handlers.ts';
import type { NativeAgentAttachmentResolver } from './attachments.ts';

import { newId } from '@monad/protocol';

export interface NativeAgentDirectBinding {
  agentId: string;
  projectId: ProjectId;
  nativeCliSessionId: string;
}

export function createNativeAgentDirectCapabilities(
  handlers: ReturnType<typeof createDaemonHandlers>,
  resolveAttachmentPayload: NativeAgentAttachmentResolver
) {
  const store = handlers._nativeAgentStore;
  return {
    async send(args: {
      body: NativeAgentSendRequest;
      binding: NativeAgentDirectBinding;
      workingPath: string;
    }): Promise<NativeAgentSendResponse> {
      const { text, noticeText, attachments } = await resolveAttachmentPayload(
        args.body,
        args.binding,
        args.workingPath
      );
      const message: NativeAgentDirectMessage = {
        id: newId('msg'),
        projectId: args.binding.projectId,
        nativeCliSessionId: args.binding.nativeCliSessionId,
        fromAgent: args.binding.agentId,
        peer: args.body.to,
        text,
        ...(attachments.length ? { attachments } : {}),
        createdAt: new Date().toISOString()
      };
      try {
        store.insertNativeAgentDirectMessage(message);
      } catch (err) {
        store.deleteMessageAttachments(attachments.map((ref) => ref.id));
        throw err;
      }
      await handlers.session.notifyManagedNativeCliDirectMessage({
        sessionId: args.binding.projectId,
        fromAgentName: args.binding.agentId,
        to: args.body.to,
        text: noticeText
      });
      return { ok: true, direct: true, message };
    },

    read(args: { body: NativeAgentReadRequest; binding: NativeAgentDirectBinding }): NativeAgentReadResponse {
      const messages = store.listNativeAgentDirectMessages(args.binding.nativeCliSessionId, args.body.with, {
        before: args.body.before,
        after: args.body.after,
        limit: args.body.limit ?? 50
      });
      return { with: args.body.with, messages, before: args.body.before, after: args.body.after };
    }
  };
}
