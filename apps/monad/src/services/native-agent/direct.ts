import type {
  NativeAgentDirectMessage,
  NativeAgentReadRequest,
  NativeAgentReadResponse,
  NativeAgentSendRequest,
  NativeAgentSendResponse
} from '@monad/protocol';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';
import type { NativeAgentAttachmentResolver } from './attachments.ts';
import type { NativeAgentRuntimeBinding } from './runtime.ts';

import { createHash } from 'node:crypto';
import { newId } from '@monad/protocol';

import { HandlerError } from '#/handlers/handler-error.ts';
import { NativeAgentDirectMessageIdempotencyConflictError } from '#/store/db/native-agent-messages.ts';
import { writeNativeAgentDirectMessageReceipt } from './direct-message-receipt.ts';

function directSendFingerprint(body: NativeAgentSendRequest, binding: NativeAgentRuntimeBinding): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        sender: {
          projectMemberId: binding.projectMemberId,
          sessionId: binding.sessionId,
          meshSessionId: binding.meshSessionId
        },
        recipient: body.to,
        deliveryMode: body.deliveryMode ?? 'queue',
        text: body.text ?? null,
        attachments: (body.attachments ?? []).map(({ path, name, mime }) => ({
          path,
          name: name ?? null,
          mime: mime ?? null
        }))
      })
    )
    .digest('hex');
}

export function createNativeAgentDirectApi(
  handlers: ReturnType<typeof createDaemonHandlers>,
  resolveAttachmentPayload: NativeAgentAttachmentResolver
) {
  const store = handlers._nativeAgentStore;
  return {
    async send(args: {
      body: NativeAgentSendRequest;
      binding: NativeAgentRuntimeBinding;
      attachmentRoots: readonly string[];
    }): Promise<NativeAgentSendResponse> {
      const requestFingerprint = directSendFingerprint(args.body, args.binding);
      // Resolve before materializing attachments or writing the ledger. Only an exact canonical member id
      // is accepted, so an invalid target leaves no direct-message, attachment, or ingress footprint.
      const target = handlers.session.resolveManagedMeshAgentDirectTarget({
        sessionId: args.binding.sessionId,
        target: args.body.to
      });
      const peer = target.projectMemberId;
      const { text, noticeText, attachments } = await resolveAttachmentPayload(
        args.body,
        { sessionId: args.binding.sessionId, createdBy: args.binding.projectMemberId },
        args.attachmentRoots
      );
      const message: NativeAgentDirectMessage = {
        id: newId('msg'),
        sessionId: args.binding.sessionId,
        meshSessionId: args.binding.meshSessionId,
        fromAgent: args.binding.projectMemberId,
        peer,
        text,
        ...(attachments.length ? { attachments } : {}),
        createdAt: new Date().toISOString()
      };
      let inserted: ReturnType<typeof store.insertNativeAgentDirectMessage>;
      try {
        inserted = store.insertNativeAgentDirectMessage(message, {
          requestId: args.body.requestId,
          requestFingerprint
        });
      } catch (error) {
        store.deleteMessageAttachments(attachments.map((ref) => ref.id));
        if (error instanceof NativeAgentDirectMessageIdempotencyConflictError) {
          throw new HandlerError('conflict', error.message, 'IDEMPOTENCY_CONFLICT');
        }
        throw error;
      }
      if (inserted.replayed) {
        store.deleteMessageAttachments(attachments.map((ref) => ref.id));
      }
      await writeNativeAgentDirectMessageReceipt({
        message: inserted.message,
        store,
        messageIngress: handlers._messageIngress
      });
      if (!inserted.replayed) {
        await handlers.session.notifyManagedMeshAgentDirectMessage({
          message: inserted.message,
          noticeText,
          deliveryMode: args.body.deliveryMode ?? 'queue'
        });
      }
      return { ok: true, direct: true, message: inserted.message };
    },

    read(args: { body: NativeAgentReadRequest; binding: NativeAgentRuntimeBinding }): NativeAgentReadResponse {
      // Reads use the same exact canonical ProjectMember id contract as sends.
      const target = handlers.session.resolveManagedMeshAgentDirectTarget({
        sessionId: args.binding.sessionId,
        target: args.body.with
      });
      const peer = target.projectMemberId;
      const messages = store.listNativeAgentDirectMessages(args.binding.meshSessionId, peer, {
        before: args.body.before,
        after: args.body.after,
        limit: args.body.limit ?? 50
      });
      return { with: peer, messages, before: args.body.before, after: args.body.after };
    }
  };
}
