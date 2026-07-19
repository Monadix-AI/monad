import type {
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

import { definePrompt } from '#/agent/prompt-template.ts';
import { HandlerError } from '#/handlers/handler-error.ts';
import { meshAgentProjectMemberDisplayNameForAgent } from '#/handlers/session/handlers/messaging-members.ts';
import { messageIdempotencyKey } from '#/services/messages/ingress.ts';
import projectAskSummaryPath from './prompts/project-ask-summary-user.prompt.md' with { type: 'file' };

const PROJECT_ASK_SUMMARY_PROMPT = await definePrompt<{
  answer: string;
  askerName: string;
  options: readonly string[];
  question: string;
}>({ id: 'native-agent.project-ask-summary.user', sourcePath: projectAskSummaryPath });

export interface NativeAgentProjectBinding {
  agentId: string;
  sessionId: SessionId;
  meshSessionId: string;
}

function assertSessionBinding(
  binding: NativeAgentProjectBinding,
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
  agentId: string
): string {
  return meshAgentProjectMemberDisplayNameForAgent(store, sessionId, agentId);
}

function readableAnswer(answer: string): string {
  try {
    const parsed = JSON.parse(answer) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed.join(', ');
    if (typeof parsed === 'string') return parsed;
  } catch {
    return answer;
  }
  return answer;
}

function projectQaWallText(args: { question: string; options: readonly string[]; answer?: string }): string {
  return [
    `Q: ${args.question}`,
    ...(args.options.length ? [`Options: ${args.options.join(' | ')}`] : []),
    ...(args.answer === undefined ? [] : [`A: ${args.answer.trim() ? readableAnswer(args.answer) : '(skipped)'}`])
  ].join('\n');
}

function projectAskSummary(args: {
  askerName: string;
  question: string;
  options: readonly string[];
  answer: string;
}): string {
  return PROJECT_ASK_SUMMARY_PROMPT.render({ ...args, answer: readableAnswer(args.answer) });
}

function enqueueProjectSummaryForManagedRuntimes(
  store: ReturnType<typeof createDaemonHandlers>['_nativeAgentStore'],
  sessionId: SessionId,
  summarySeq: number,
  exceptMeshSessionId: string
): void {
  for (const session of store.listMeshSessionsForTranscriptTarget(sessionId)) {
    if (session.id === exceptMeshSessionId) continue;
    if (session.runtimeRole !== 'managed-project-agent') continue;
    store.enqueueMeshAgentInboxItem(session.id, summarySeq);
  }
}

export function createNativeAgentProjectCapabilities(
  handlers: ReturnType<typeof createDaemonHandlers>,
  resolveAttachmentPayload: NativeAgentAttachmentResolver
) {
  const store = handlers._nativeAgentStore;
  return {
    async post(args: {
      body: NativeAgentProjectPostRequest;
      binding: NativeAgentProjectBinding;
      attachmentRoots: readonly string[];
    }): Promise<NativeAgentProjectPostResponse> {
      const sessionId = assertSessionBinding(args.binding, args.body.sessionId);
      const { text, noticeText, attachments } = await resolveAttachmentPayload(
        args.body,
        args.binding,
        args.attachmentRoots
      );
      let messageId: `msg_${string}`;
      try {
        const completed = await handlers.session.completeManagedMeshAgentProjectMessage({
          sessionId: sessionId,
          meshSessionId: args.binding.meshSessionId,
          agentName: args.binding.agentId,
          text,
          threadId: args.body.threadId,
          attachments
        });
        messageId = completed.messageId;
      } catch (err) {
        store.deleteMessageAttachments(attachments.map((ref) => ref.id));
        throw err;
      }
      const createdAt = new Date().toISOString();
      store.markMeshAgentInboxConsumed(args.binding.meshSessionId, store.maxMessageSeq(sessionId));
      await handlers.session.notifyManagedMeshAgentProjectMembers({
        sessionId: sessionId,
        text: noticeText,
        sender: { kind: 'mesh-agent', name: args.binding.agentId, id: args.binding.agentId },
        triggerMessageId: messageId,
        exceptAgentName: args.binding.agentId
      });
      return {
        ok: true,
        message: {
          id: messageId,
          sessionId,
          text,
          ...(attachments.length ? { attachments } : {}),
          createdAt
        }
      };
    },

    async ask(args: {
      body: NativeAgentProjectAskRequest;
      binding: NativeAgentProjectBinding;
      signal?: AbortSignal;
    }): Promise<NativeAgentProjectAskResponse> {
      const sessionId = assertSessionBinding(args.binding, args.body.sessionId);
      const askerName = managedMeshAgentDisplayName(store, sessionId, args.binding.agentId);
      const wall = await handlers._transcriptProjector.insertAssistantMessage({
        sessionId: sessionId,
        agentName: askerName,
        text: projectQaWallText({ question: args.body.question, options: args.body.options }),
        data: { kind: 'project-qa' },
        includeInContext: false,
        streamStatus: 'streaming'
      });
      const result = await handlers.clarify.askStructured(
        sessionId,
        {
          question: args.body.question,
          options: args.body.options,
          mode: args.body.mode,
          allowOther: args.body.allowOther,
          asker: { id: args.binding.agentId, name: askerName }
        },
        { signal: args.signal, waitForever: true }
      );
      await handlers._transcriptProjector.completeAssistantMessage({
        sessionId: sessionId,
        messageId: wall.messageId,
        agentName: askerName,
        text: projectQaWallText({ question: args.body.question, options: args.body.options, answer: result.answer })
      });
      if (result.requestId && result.answer.trim()) {
        const summary = projectAskSummary({
          askerName,
          question: args.body.question,
          options: args.body.options,
          answer: result.answer
        });
        const summaryMessage = await handlers._messageIngress.deliver({
          transcriptTargetId: sessionId,
          idempotencyKey: messageIdempotencyKey('project-ask-summary', sessionId, result.requestId),
          producer: { kind: 'system', subsystem: 'project-qa' },
          role: 'system',
          type: 'text',
          text: summary,
          data: {
            source: 'managed-mesh-agent-question',
            requestId: result.requestId,
            agentName: args.binding.agentId,
            meshSessionId: args.binding.meshSessionId
          },
          includeInContext: true
        });
        const summarySeq = store.messageSeq(sessionId, summaryMessage.id);
        enqueueProjectSummaryForManagedRuntimes(store, sessionId, summarySeq, args.binding.meshSessionId);
        await handlers.session.notifyManagedMeshAgentProjectMembers({
          sessionId: sessionId,
          text: summary,
          sender: { kind: 'system', name: 'Project Q&A summary', id: 'system:project-qa' },
          triggerMessageId: summaryMessage.id,
          exceptAgentName: args.binding.agentId
        });
      }
      return { ok: true, requestId: result.requestId, answer: result.answer };
    },

    read(args: {
      body: NativeAgentProjectReadRequest;
      binding: NativeAgentProjectBinding;
    }): NativeAgentProjectReadResponse {
      const sessionId = assertSessionBinding(args.binding, args.body.sessionId);
      const messages = store.listMessages(sessionId, {
        limit: args.body.limit ?? 50,
        threadId: args.body.threadId,
        before: args.body.before,
        after: args.body.after,
        around: args.body.around,
        latest: !args.body.before && !args.body.after && !args.body.around
      });
      if (!args.body.threadId && !args.body.before && !args.body.after && !args.body.around) {
        const visibleSeq = store.maxMessageSeq(sessionId);
        if (visibleSeq > 0) store.markMeshAgentInboxVisible(args.binding.meshSessionId, visibleSeq);
      }
      return { messages };
    },

    inbox(args: {
      body: NativeAgentProjectInboxRequest;
      binding: NativeAgentProjectBinding;
      lastVisibleSeq: number;
    }): NativeAgentProjectInboxResponse {
      const sessionId = assertSessionBinding(args.binding, args.body?.sessionId);
      const items = store.listMeshAgentInbox(args.binding.meshSessionId);
      const cursor = items.at(-1)?.seq ?? args.lastVisibleSeq;
      if (items.length > 0) store.markMeshAgentInboxVisible(args.binding.meshSessionId, cursor);
      return { items, sessionId, cursor };
    },

    ack(args: {
      body: NativeAgentProjectInboxAckRequest;
      binding: NativeAgentProjectBinding;
    }): NativeAgentProjectInboxAckResponse {
      const sessionId = assertSessionBinding(args.binding, args.body?.sessionId);
      const cursor = args.body?.cursor ?? store.getMeshSession(args.binding.meshSessionId)?.lastVisibleSeq ?? 0;
      store.markMeshAgentInboxConsumed(args.binding.meshSessionId, cursor);
      return { ok: true, sessionId, cursor };
    }
  };
}
