import type {
  MessageAttachmentRef,
  NativeAgentProjectAskCancelRequest,
  NativeAgentProjectAskCancelResponse,
  NativeAgentProjectAskRequest,
  NativeAgentProjectAskResponse,
  NativeAgentProjectInboxAckRequest,
  NativeAgentProjectInboxAckResponse,
  NativeAgentProjectInboxRequest,
  NativeAgentProjectInboxResponse,
  NativeAgentProjectPostRequest,
  NativeAgentProjectPostResponse,
  NativeAgentProjectReadRequest,
  NativeAgentProjectReadResponse,
  SessionId
} from '@monad/protocol';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';
import type { NativeAgentAttachmentResolver } from './attachments.ts';
import type { NativeAgentRuntimeBinding } from './runtime.ts';

import { meshSessionIdSchema, newId } from '@monad/protocol';
import { z } from 'zod';

import { HandlerError } from '#/handlers/handler-error.ts';
import { meshAgentProjectMemberDisplayNameForAgent } from '#/handlers/session/handlers/messaging-members.ts';
import { messageIdempotencyKey } from '#/services/messages/ingress.ts';
import { writeNativeAgentDirectMessageReceipt } from './direct-message-receipt.ts';
import { nativeAgentMemberDeliveryCoordinatorFor } from './member-delivery-coordinator.ts';
import { parseProjectAskAnswers } from './project-ask-answers.ts';
import { createNativeAgentProjectAskRecovery } from './project-ask-recovery.ts';
import { createNativeAgentProjectAskWatchdog } from './project-ask-watchdog.ts';

function assertSessionBinding(
  binding: NativeAgentRuntimeBinding,
  requestedSessionId: SessionId | undefined
): SessionId {
  const sessionId = requestedSessionId ?? binding.sessionId;
  if (binding.sessionId !== sessionId) {
    throw new HandlerError('forbidden', 'session id does not match managed runtime', 'PROJECT_MISMATCH');
  }
  return sessionId;
}

function managedMeshAgentDisplayName(
  store: ReturnType<typeof createDaemonHandlers>['_nativeAgentStore'],
  sessionId: SessionId,
  projectMemberId: string
): string {
  return meshAgentProjectMemberDisplayNameForAgent(store, sessionId, projectMemberId);
}

function readableAnswer(answer: string): string {
  try {
    const parsed = z.union([z.string(), z.array(z.string())]).parse(JSON.parse(answer));
    if (Array.isArray(parsed)) return parsed.join(', ');
    if (typeof parsed === 'string') return parsed;
  } catch {
    return answer;
  }
  return answer;
}

type ProjectAskQuestion = NativeAgentProjectAskRequest['questions'][number];

function projectQaWallText(args: { questions: readonly ProjectAskQuestion[]; answer?: string }): string {
  return args.questions
    .flatMap((question, index) => [
      `${args.questions.length === 1 ? 'Q' : `Q${index + 1}`}: ${question.question}`,
      ...(question.options.length ? [`Options: ${question.options.join(' | ')}`] : []),
      ...(args.answer === undefined || args.questions.length > 1
        ? []
        : [`A: ${args.answer.trim() ? readableAnswer(args.answer) : '(skipped)'}`])
    ])
    .join('\n');
}

function enqueueCanonicalAnswerForManagedRuntimes(
  store: ReturnType<typeof createDaemonHandlers>['_nativeAgentStore'],
  sessionId: SessionId,
  answerMessageId: `msg_${string}`,
  exceptMeshSessionId: string
): void {
  const messageSeq = store.messageSeq(sessionId, answerMessageId);
  for (const session of store.listMeshSessionsForTranscriptTarget(sessionId)) {
    if (session.id === exceptMeshSessionId) continue;
    if (session.runtimeRole !== 'managed-project-agent') continue;
    store.enqueueMeshAgentInboxItem(session.id, messageSeq, {
      memberInstanceId: session.projectMemberId ?? undefined
    });
  }
}

export function createNativeAgentProjectApi(
  handlers: ReturnType<typeof createDaemonHandlers>,
  resolveAttachmentPayload: NativeAgentAttachmentResolver
) {
  const store = handlers._nativeAgentStore;
  const memberDeliveryCoordinator = nativeAgentMemberDeliveryCoordinatorFor(store);
  const projectAskRecovery = createNativeAgentProjectAskRecovery({
    store,
    coordinator: memberDeliveryCoordinator,
    input: async (meshSessionId, prompt, onAccepted) => {
      const meshSession = store.getMeshSession(meshSessionId);
      if (!meshSession) throw new Error(`MeshAgent session not found: ${meshSessionId}`);
      const completion = handlers.meshAgent.input({
        id: meshSessionId,
        transcriptTargetId: meshSession.transcriptTargetId,
        input: prompt
      });
      onAccepted();
      await completion;
    },
    writeDirectReceipt: async (directMessageId) => {
      const message = store.getNativeAgentDirectMessage(directMessageId);
      if (!message) throw new Error(`Native-agent direct message not found: ${directMessageId}`);
      await writeNativeAgentDirectMessageReceipt({ message, store, messageIngress: handlers._messageIngress });
    }
  });
  const projectAskWatchdog = createNativeAgentProjectAskWatchdog({
    gateMatches: (entry) =>
      store.getNativeAgentMemberGate(entry.projectSessionId, entry.memberInstanceId)?.requestId === entry.requestId,
    isTurnActive: (entry) => memberDeliveryCoordinator.isTurnActive(entry.projectSessionId, entry.memberInstanceId),
    interrupt: (meshSessionId) => {
      const meshSession = store.getMeshSession(meshSessionId);
      if (meshSession)
        handlers.meshAgent.interrupt({ id: meshSessionId, transcriptTargetId: meshSession.transcriptTargetId });
    },
    stop: (meshSessionId) => {
      const meshSession = store.getMeshSession(meshSessionId);
      if (meshSession)
        void handlers.meshAgent
          .stop({ id: meshSessionId, transcriptTargetId: meshSession.transcriptTargetId })
          .catch(() => undefined);
    }
  });
  return {
    async post(args: {
      body: NativeAgentProjectPostRequest;
      binding: NativeAgentRuntimeBinding;
      attachmentRoots: readonly string[];
    }): Promise<NativeAgentProjectPostResponse> {
      const sessionId = assertSessionBinding(args.binding, args.body.sessionId);
      const idempotencyKey = messageIdempotencyKey(
        'native-agent-project-post',
        sessionId,
        args.binding.projectMemberId,
        args.body.requestId
      );
      const placeholderRemovalIdempotencyKey = messageIdempotencyKey(
        'native-agent-project-post-placeholder-removal',
        sessionId,
        args.binding.projectMemberId,
        args.body.requestId
      );
      const { text, noticeText, attachments } = await resolveAttachmentPayload(
        args.body,
        { sessionId, createdBy: args.binding.projectMemberId },
        args.attachmentRoots
      );
      let completed: Awaited<ReturnType<typeof handlers.session.completeManagedMeshAgentProjectMessage>>;
      try {
        completed = await handlers.session.completeManagedMeshAgentProjectMessage({
          sessionId: sessionId,
          meshSessionId: args.binding.meshSessionId,
          projectMemberId: args.binding.projectMemberId,
          text,
          replyToMessageId: args.body.replyToMessageId,
          attachments,
          idempotencyKey,
          placeholderRemovalIdempotencyKey
        });
      } catch (error) {
        store.deleteMessageAttachments(attachments.map((ref) => ref.id));
        if (error instanceof Error && error.message === 'idempotency key reused with a different command') {
          throw new HandlerError('conflict', error.message, 'IDEMPOTENCY_CONFLICT');
        }
        throw error;
      }
      if (!completed.changed) {
        store.deleteMessageAttachments(attachments.map((ref) => ref.id));
      } else {
        store.markMeshAgentInboxConsumed(args.binding.meshSessionId, store.maxMessageSeq(sessionId));
        await handlers.session.notifyManagedMeshAgentProjectMembers({
          sessionId: sessionId,
          text: noticeText,
          sender: {
            kind: 'mesh-agent',
            name: args.binding.projectMemberId,
            id: args.binding.projectMemberId
          },
          triggerMessageId: completed.messageId,
          exceptProjectMemberId: args.binding.projectMemberId
        });
      }
      const persistedData =
        completed.message.data && typeof completed.message.data === 'object'
          ? (completed.message.data as { attachments?: MessageAttachmentRef[] })
          : undefined;
      const persistedAttachments = persistedData?.attachments;
      return {
        ok: true,
        message: {
          id: completed.messageId,
          sessionId,
          text: completed.message.text,
          ...(completed.message.replyToMessageId ? { replyToMessageId: completed.message.replyToMessageId } : {}),
          ...(persistedAttachments?.length ? { attachments: persistedAttachments } : {}),
          createdAt: completed.message.createdAt
        }
      };
    },

    async ask(args: {
      body: NativeAgentProjectAskRequest;
      binding: NativeAgentRuntimeBinding;
      signal?: AbortSignal;
    }): Promise<NativeAgentProjectAskResponse> {
      const sessionId = assertSessionBinding(args.binding, args.body.sessionId);
      const projectId = store.getSession(sessionId)?.projectId;
      if (!projectId) throw new HandlerError('not_found', 'managed runtime project not found', 'PROJECT_NOT_FOUND');
      const askerName = managedMeshAgentDisplayName(store, sessionId, args.binding.projectMemberId);
      const requestId = args.body.requestId ?? newId('clarify');
      const createdAt = new Date();
      const expiresAt =
        args.body.autoResolutionMs === undefined
          ? undefined
          : new Date(createdAt.getTime() + args.body.autoResolutionMs).toISOString();
      try {
        await memberDeliveryCoordinator.runExclusive(sessionId, args.binding.projectMemberId, () =>
          store.createNativeAgentAsk({
            requestId,
            projectId,
            projectSessionId: sessionId,
            memberInstanceId: args.binding.projectMemberId,
            meshSessionId: args.binding.meshSessionId,
            blocking: args.body.blocking,
            questions: args.body.questions,
            ...(expiresAt === undefined ? {} : { expiresAt }),
            createdAt: createdAt.toISOString()
          })
        );
      } catch (error) {
        if (error instanceof Error && error.message.includes('already has an unresolved project ask')) {
          throw new HandlerError('conflict', error.message, 'PROJECT_ASK_PENDING');
        }
        throw error;
      }
      const wall = await handlers._transcriptProjector.insertAssistantMessage({
        sessionId: sessionId,
        agentName: askerName,
        text: projectQaWallText({ questions: args.body.questions }),
        data:
          args.body.questions.length === 1
            ? {
                kind: 'project-qa',
                question: args.body.questions[0]?.question ?? '',
                options: args.body.questions[0]?.options ?? []
              }
            : { kind: 'project-qa', requestId, questions: args.body.questions },
        includeInContext: false,
        streamStatus: 'complete'
      });
      const pending = handlers.clarify.askStructured(
        sessionId,
        {
          requestId,
          question: args.body.questions[0]?.question ?? '',
          questions: args.body.questions,
          blocking: args.body.blocking,
          options: args.body.questions[0]?.options,
          mode: args.body.questions[0]?.mode,
          allowOther: args.body.questions[0]?.allowOther,
          asker: { id: args.binding.projectMemberId, name: askerName },
          autoResolutionMs: args.body.autoResolutionMs,
          origin: {
            kind: 'managed-project',
            meshSessionId: args.binding.meshSessionId,
            agentId: args.binding.projectMemberId
          },
          questionMessage: {
            id: wall.messageId,
            createdAt: store.getMessage(sessionId, wall.messageId)?.createdAt ?? createdAt.toISOString()
          }
        },
        { signal: args.signal }
      );
      const finalize = async (result: Awaited<typeof pending>): Promise<NativeAgentProjectAskResponse> => {
        const outcome =
          result.status === 'timed-out'
            ? 'timed_out'
            : result.status === 'cancelled'
              ? 'cancelled'
              : result.answer.trim()
                ? 'answered'
                : 'skipped';
        const answers = parseProjectAskAnswers(args.body.questions, result.answer);
        store.settleNativeAgentAsk({
          requestId,
          outcome,
          ...(outcome === 'answered' ? { answers } : {})
        });
        if (outcome === 'answered' && result.answerMessageId) {
          const answerText = store.getMessage(sessionId, result.answerMessageId)?.text ?? result.answer;
          enqueueCanonicalAnswerForManagedRuntimes(
            store,
            sessionId,
            result.answerMessageId,
            args.binding.meshSessionId
          );
          await handlers.session.notifyManagedMeshAgentProjectMembers({
            sessionId,
            text: answerText,
            sender: { kind: 'human', name: 'Human' },
            triggerMessageId: result.answerMessageId,
            exceptProjectMemberId: args.binding.projectMemberId
          });
        }
        void projectAskRecovery.schedule(requestId, { includeOutcome: args.body.blocking }).catch(() => {});
        if (outcome === 'answered') {
          return { ok: true, requestId, status: 'answered', answer: result.answer, answers };
        }
        return { ok: true, requestId, status: outcome };
      };

      if (args.body.blocking) {
        void pending.then(finalize).catch(() => {
          store.settleNativeAgentAsk({ requestId, outcome: 'cancelled' });
        });
        projectAskWatchdog.arm({
          requestId,
          projectId,
          projectSessionId: sessionId,
          memberInstanceId: args.binding.projectMemberId,
          meshSessionId: args.binding.meshSessionId
        });
        return { ok: true, requestId, status: 'awaiting_human', instruction: 'end_turn' };
      }
      return finalize(await pending);
    },

    async cancel(args: {
      body: NativeAgentProjectAskCancelRequest;
      binding: NativeAgentRuntimeBinding;
    }): Promise<NativeAgentProjectAskCancelResponse> {
      const projectId = store.getSession(args.binding.sessionId)?.projectId;
      if (!projectId) throw new HandlerError('not_found', 'managed runtime project not found', 'PROJECT_NOT_FOUND');
      const status = store.cancelNativeAgentAsk({
        requestId: args.body.requestId,
        projectId,
        memberInstanceId: args.binding.projectMemberId,
        cause: args.body.cause
      });
      if (!status) throw new HandlerError('not_found', 'project ask not found', 'PROJECT_ASK_NOT_FOUND');
      if (status !== 'detached_sync') {
        await projectAskRecovery.schedule(args.body.requestId, { includeOutcome: true });
      }
      return { ok: true, requestId: args.body.requestId, status };
    },

    read(args: {
      body: NativeAgentProjectReadRequest;
      binding: NativeAgentRuntimeBinding;
    }): NativeAgentProjectReadResponse {
      const sessionId = assertSessionBinding(args.binding, args.body.sessionId);
      if (args.body.messageId) {
        const result = handlers._messageLookup.get({
          transcriptTargetId: sessionId,
          messageId: args.body.messageId,
          actor: {
            kind: 'managed-agent',
            meshSessionId: meshSessionIdSchema.parse(args.binding.meshSessionId)
          }
        });
        return { messages: result.status === 'found' ? [result.message] : [] };
      }
      const messages = store.listMessages(sessionId, {
        limit: args.body.limit ?? 50,
        before: args.body.before,
        after: args.body.after,
        around: args.body.around,
        latest: !args.body.before && !args.body.after && !args.body.around
      });
      return { messages };
    },

    inbox(args: {
      body: NativeAgentProjectInboxRequest;
      binding: NativeAgentRuntimeBinding;
      lastVisibleSeq: number;
    }): NativeAgentProjectInboxResponse {
      const sessionId = assertSessionBinding(args.binding, args.body?.sessionId);
      const projectId = store.getSession(sessionId)?.projectId;
      if (!projectId) throw new HandlerError('not_found', 'managed runtime project not found', 'PROJECT_NOT_FOUND');
      const items = store.consumeNativeAgentPendingInbox(projectId, sessionId, args.binding.projectMemberId);
      const cursor = items.at(-1)?.ingressSeq ?? args.lastVisibleSeq;
      if (items.length > 0) store.setMeshAgentVisibleCursor(args.binding.meshSessionId, cursor);
      return { items, sessionId, cursor };
    },

    ack(args: {
      body: NativeAgentProjectInboxAckRequest;
      binding: NativeAgentRuntimeBinding;
    }): NativeAgentProjectInboxAckResponse {
      const sessionId = assertSessionBinding(args.binding, args.body?.sessionId);
      const projectId = store.getSession(sessionId)?.projectId;
      if (!projectId) throw new HandlerError('not_found', 'managed runtime project not found', 'PROJECT_NOT_FOUND');
      const cursor = args.body?.cursor ?? store.getMeshSession(args.binding.meshSessionId)?.lastVisibleSeq ?? 0;
      const result = store.acknowledgeVisibleNativeAgentIngress({
        projectId,
        sessionId,
        memberInstanceId: args.binding.projectMemberId,
        requestedCursor: cursor
      });
      store.setMeshAgentVisibleCursor(args.binding.meshSessionId, result.visibleCursor);
      return { ok: true, sessionId, cursor, ...result };
    }
  };
}
