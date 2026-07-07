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
  ProjectId
} from '@monad/protocol';
import type { createDaemonHandlers } from '@/handlers/daemon-handlers/index.ts';
import type { NativeAgentAttachmentResolver } from './attachments.ts';

import { newId } from '@monad/protocol';

import { HandlerError } from '@/handlers/handler-error.ts';
import { externalAgentProjectMemberDisplayNameForAgent } from '@/handlers/session/handlers/messaging-members.ts';

export interface NativeAgentProjectBinding {
  agentId: string;
  projectId: ProjectId;
  externalAgentSessionId: string;
}

function assertProjectBinding(
  binding: NativeAgentProjectBinding,
  requestedProjectId: ProjectId | undefined
): ProjectId {
  const projectId = requestedProjectId ?? binding.projectId;
  if (binding.projectId !== projectId) {
    throw new HandlerError('forbidden', 'project id does not match managed runtime', 'PROJECT_MISMATCH');
  }
  return projectId;
}

function managedExternalAgentDisplayName(
  store: ReturnType<typeof createDaemonHandlers>['_nativeAgentStore'],
  projectId: ProjectId,
  agentId: string
): string {
  const session = store.getSession(projectId) ?? store.getWorkplaceProject(projectId);
  return session ? externalAgentProjectMemberDisplayNameForAgent(session, agentId) : agentId;
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
  return [
    'Project Q&A summary:',
    `Asked by: ${args.askerName}`,
    `Question: ${args.question}`,
    ...(args.options.length ? [`Options: ${args.options.join(' | ')}`] : []),
    `User answer: ${readableAnswer(args.answer)}`,
    '',
    'Use this as shared project context. Do not repeat it unless it changes your task-relevant response.'
  ].join('\n');
}

function enqueueProjectSummaryForManagedRuntimes(
  store: ReturnType<typeof createDaemonHandlers>['_nativeAgentStore'],
  projectId: ProjectId,
  summarySeq: number,
  exceptExternalAgentSessionId: string
): void {
  for (const session of store.listExternalAgentSessionsForTranscriptTarget(projectId)) {
    if (session.id === exceptExternalAgentSessionId) continue;
    if (session.runtimeRole !== 'managed-project-agent') continue;
    store.enqueueExternalAgentInboxItem(session.id, summarySeq);
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
      const projectId = assertProjectBinding(args.binding, args.body.projectId);
      const { text, noticeText, attachments } = await resolveAttachmentPayload(
        args.body,
        args.binding,
        args.attachmentRoots
      );
      let messageId: `msg_${string}`;
      try {
        const completed = await handlers.session.completeManagedExternalAgentProjectMessage({
          sessionId: projectId,
          externalAgentSessionId: args.binding.externalAgentSessionId,
          agentName: args.binding.agentId,
          text,
          threadId: args.body.threadId,
          attachments
        });
        messageId = completed.messageId ?? newId('msg');
      } catch (err) {
        store.deleteMessageAttachments(attachments.map((ref) => ref.id));
        throw err;
      }
      const createdAt = new Date().toISOString();
      store.markExternalAgentInboxConsumed(args.binding.externalAgentSessionId, store.maxMessageSeq(projectId));
      await handlers.session.notifyManagedExternalAgentProjectMembers({
        sessionId: projectId,
        text: noticeText,
        sender: { kind: 'external-agent', name: args.binding.agentId, id: args.binding.agentId },
        exceptAgentName: args.binding.agentId
      });
      return {
        ok: true,
        message: {
          id: messageId,
          projectId,
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
      const projectId = assertProjectBinding(args.binding, args.body.projectId);
      const askerName = managedExternalAgentDisplayName(store, projectId, args.binding.agentId);
      const wall = handlers._transcriptProjector.insertAssistantMessage({
        transcriptTargetId: projectId,
        agentName: askerName,
        text: projectQaWallText({ question: args.body.question, options: args.body.options }),
        data: { kind: 'project-qa' },
        includeInContext: false,
        streamStatus: 'streaming'
      });
      const result = await handlers.clarify.askStructured(
        projectId,
        {
          question: args.body.question,
          options: args.body.options,
          mode: args.body.mode,
          allowOther: args.body.allowOther,
          asker: { id: args.binding.agentId, name: askerName }
        },
        { signal: args.signal, waitForever: true }
      );
      handlers._transcriptProjector.completeAssistantMessage({
        transcriptTargetId: projectId,
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
        const summaryMessageId = newId('msg');
        store.insertMessage(summaryMessageId, projectId, summary, new Date().toISOString(), 'system', {
          data: {
            source: 'managed-external-agent-question',
            requestId: result.requestId,
            agentName: args.binding.agentId,
            externalAgentSessionId: args.binding.externalAgentSessionId
          },
          includeInContext: true
        });
        const summarySeq = store.messageSeq(projectId, summaryMessageId);
        enqueueProjectSummaryForManagedRuntimes(store, projectId, summarySeq, args.binding.externalAgentSessionId);
        await handlers.session.notifyManagedExternalAgentProjectMembers({
          sessionId: projectId,
          text: summary,
          sender: { kind: 'system', name: 'Project Q&A summary', id: 'system:project-qa' },
          exceptAgentName: args.binding.agentId
        });
      }
      return { ok: true, requestId: result.requestId, answer: result.answer };
    },

    read(args: {
      body: NativeAgentProjectReadRequest;
      binding: NativeAgentProjectBinding;
    }): NativeAgentProjectReadResponse {
      const projectId = assertProjectBinding(args.binding, args.body.projectId);
      const messages = store.listMessages(projectId, {
        limit: args.body.limit ?? 50,
        threadId: args.body.threadId,
        before: args.body.before,
        after: args.body.after,
        around: args.body.around,
        latest: !args.body.before && !args.body.after && !args.body.around
      });
      if (!args.body.threadId && !args.body.before && !args.body.after && !args.body.around) {
        const visibleSeq = store.maxMessageSeq(projectId);
        if (visibleSeq > 0) store.markExternalAgentInboxVisible(args.binding.externalAgentSessionId, visibleSeq);
      }
      return { messages };
    },

    inbox(args: {
      body: NativeAgentProjectInboxRequest;
      binding: NativeAgentProjectBinding;
      lastVisibleSeq: number;
    }): NativeAgentProjectInboxResponse {
      const projectId = assertProjectBinding(args.binding, args.body?.projectId);
      const items = store.listExternalAgentInbox(args.binding.externalAgentSessionId);
      const cursor = items.at(-1)?.seq ?? args.lastVisibleSeq;
      if (items.length > 0) store.markExternalAgentInboxVisible(args.binding.externalAgentSessionId, cursor);
      return { items, projectId, cursor };
    },

    ack(args: {
      body: NativeAgentProjectInboxAckRequest;
      binding: NativeAgentProjectBinding;
    }): NativeAgentProjectInboxAckResponse {
      const projectId = assertProjectBinding(args.binding, args.body?.projectId);
      const cursor = args.body?.cursor ?? store.maxMessageSeq(projectId);
      store.markExternalAgentInboxConsumed(args.binding.externalAgentSessionId, cursor);
      return { ok: true, projectId, cursor };
    }
  };
}
