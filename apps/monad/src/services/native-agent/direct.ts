import type {
  NativeAgentDirectMessage,
  NativeAgentReadRequest,
  NativeAgentReadResponse,
  NativeAgentSendRequest,
  NativeAgentSendResponse,
  SessionId
} from '@monad/protocol';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';
import type { NativeAgentAttachmentResolver } from './attachments.ts';

import { newId } from '@monad/protocol';

export interface NativeAgentDirectBinding {
  agentId: string;
  sessionId: SessionId;
  externalAgentSessionId: string;
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
      attachmentRoots: readonly string[];
    }): Promise<NativeAgentSendResponse> {
      const { text, noticeText, attachments } = await resolveAttachmentPayload(
        args.body,
        args.binding,
        args.attachmentRoots
      );
      const message: NativeAgentDirectMessage = {
        id: newId('msg'),
        sessionId: args.binding.sessionId,
        externalAgentSessionId: args.binding.externalAgentSessionId,
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
      await handlers.session.notifyManagedExternalAgentDirectMessage({
        sessionId: args.binding.sessionId,
        fromAgentName: args.binding.agentId,
        to: args.body.to,
        text: noticeText
      });
      return { ok: true, direct: true, message };
    },

    read(args: { body: NativeAgentReadRequest; binding: NativeAgentDirectBinding }): NativeAgentReadResponse {
      const messages = store.listNativeAgentDirectMessages(args.binding.externalAgentSessionId, args.body.with, {
        before: args.body.before,
        after: args.body.after,
        limit: args.body.limit ?? 50
      });
      return { with: args.body.with, messages, before: args.body.before, after: args.body.after };
    }
  };
}
