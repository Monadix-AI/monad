import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import { createHash, timingSafeEqual } from 'node:crypto';
import { daemonHttpContract, newId, type ProjectId } from '@monad/protocol';
import { Elysia } from 'elysia';

import { HandlerError } from '@/handlers/handler-error.ts';
import { nativeCliProjectMemberDisplayNameForAgent } from '@/handlers/session/handlers/messaging-members.ts';

function runtimeBinding(request: Request) {
  return {
    nativeCliSessionId: request.headers.get('x-monad-native-cli-session-id')
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tokenMatchesHash(providedToken: string, expectedHash: string): boolean {
  const provided = Buffer.from(hashToken(providedToken), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function managedNativeCliDisplayName(
  store: ReturnType<typeof createDaemonHandlers>['_nativeAgentStore'],
  projectId: ProjectId,
  agentId: string
): string {
  const session = store.getSession(projectId) ?? store.getWorkplaceProject(projectId);
  return session ? nativeCliProjectMemberDisplayNameForAgent(session, agentId) : agentId;
}

function readableAnswer(answer: string): string {
  try {
    const parsed = JSON.parse(answer) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed.join(', ');
    if (typeof parsed === 'string') return parsed;
  } catch {
    // Plain text answer.
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
  exceptNativeCliSessionId: string
): void {
  for (const session of store.listNativeCliSessionsForTranscriptTarget(projectId)) {
    if (session.id === exceptNativeCliSessionId) continue;
    if (session.runtimeRole !== 'managed-project-agent') continue;
    store.enqueueNativeCliInboxItem(session.id, summarySeq);
  }
}

export function createNativeAgentController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const store = handlers._nativeAgentStore;
  const contracts = daemonHttpContract.nativeAgent;
  const requireManagedBinding = (request: Request) => {
    const binding = runtimeBinding(request);
    if (!binding.nativeCliSessionId) {
      throw new HandlerError(
        'forbidden',
        'current runtime is not a project-managed native CLI agent',
        'NOT_MANAGED_NATIVE_CLI'
      );
    }
    const nativeSession = store.getNativeCliSession(binding.nativeCliSessionId);
    if (!nativeSession) {
      throw new HandlerError(
        'not_found',
        `native CLI session not found: ${binding.nativeCliSessionId}`,
        'NATIVE_CLI_SESSION_NOT_FOUND'
      );
    }
    if (nativeSession.runtimeRole !== 'managed-project-agent') {
      throw new HandlerError(
        'forbidden',
        'current runtime is not a project-managed native CLI agent',
        'NOT_MANAGED_NATIVE_CLI'
      );
    }
    if (nativeSession.state !== 'running') {
      throw new HandlerError('forbidden', 'managed native CLI session is not active', 'NATIVE_CLI_SESSION_NOT_ACTIVE');
    }
    if (!nativeSession.transcriptTargetId.startsWith('prj_')) {
      throw new HandlerError(
        'forbidden',
        'managed native CLI session is not bound to a Workplace Project',
        'NOT_PROJECT_MANAGED_NATIVE_CLI'
      );
    }
    const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
    if (!nativeSession.agentRuntimeTokenHash || !tokenMatchesHash(token, nativeSession.agentRuntimeTokenHash)) {
      throw new HandlerError('forbidden', 'invalid managed native CLI agent token', 'INVALID_NATIVE_AGENT_TOKEN');
    }
    return {
      binding: {
        agentId: nativeSession.agentName,
        projectId: nativeSession.transcriptTargetId as ProjectId,
        nativeCliSessionId: binding.nativeCliSessionId
      },
      nativeSession
    };
  };
  return new Elysia({ tags: ['http-only'] })
    .post(
      '/internal/native-agent/project/post',
      async ({ body, request }) => {
        const { binding } = requireManagedBinding(request);
        const projectId = body.projectId ?? binding.projectId;
        if (binding.projectId !== projectId) {
          throw new HandlerError('forbidden', 'project id does not match managed runtime', 'PROJECT_MISMATCH');
        }
        const transcriptTargetId = projectId;
        const completed = await handlers.session.completeManagedNativeCliProjectMessage({
          sessionId: transcriptTargetId,
          nativeCliSessionId: binding.nativeCliSessionId,
          agentName: binding.agentId,
          text: body.text,
          threadId: body.threadId
        });
        const messageId = completed.messageId ?? newId('msg');
        const createdAt = new Date().toISOString();
        store.markNativeCliInboxConsumed(binding.nativeCliSessionId, store.maxMessageSeq(transcriptTargetId));
        await handlers.session.notifyManagedNativeCliProjectMembers({
          sessionId: transcriptTargetId,
          text: body.text,
          sender: { kind: 'native-cli-agent', name: binding.agentId, id: binding.agentId },
          exceptAgentName: binding.agentId
        });
        return { ok: true, message: { id: messageId, projectId, text: body.text, createdAt } };
      },
      { body: contracts.projectPost.body, response: contracts.projectPost.response }
    )
    .post(
      '/internal/native-agent/project/ask',
      async ({ body, request, server }) => {
        const { binding } = requireManagedBinding(request);
        const projectId = body.projectId ?? binding.projectId;
        if (binding.projectId !== projectId) {
          throw new HandlerError('forbidden', 'project id does not match managed runtime', 'PROJECT_MISMATCH');
        }
        // The response is held open until a human answers — indefinitely by design. Bun's
        // default idleTimeout closes a silent connection after ~10s, which would drop the
        // answer while the clarify stays pending — disable it for this request only.
        server?.timeout(request, 0);
        const askerName = managedNativeCliDisplayName(store, projectId, binding.agentId);
        const wallQuestion = projectQaWallText({ question: body.question, options: body.options });
        const wall = handlers.session.beginProjectQaWallMessage({
          sessionId: projectId,
          agentName: askerName,
          text: wallQuestion
        });
        const result = await handlers.clarify.askStructured(
          projectId,
          {
            question: body.question,
            options: body.options,
            mode: body.mode,
            allowOther: body.allowOther,
            asker: { id: binding.agentId, name: askerName }
          },
          { waitForever: true }
        );
        handlers.session.completeProjectQaWallMessage({
          sessionId: projectId,
          messageId: wall.messageId,
          agentName: askerName,
          text: projectQaWallText({ question: body.question, options: body.options, answer: result.answer })
        });
        if (result.requestId && result.answer.trim()) {
          const summary = projectAskSummary({
            askerName,
            question: body.question,
            options: body.options,
            answer: result.answer
          });
          store.insertMessage(newId('msg'), projectId, summary, new Date().toISOString(), 'system', {
            data: {
              source: 'managed-native-cli-question',
              requestId: result.requestId,
              agentName: binding.agentId,
              nativeCliSessionId: binding.nativeCliSessionId
            },
            includeInContext: true
          });
          const summarySeq = store.maxMessageSeq(projectId);
          enqueueProjectSummaryForManagedRuntimes(store, projectId, summarySeq, binding.nativeCliSessionId);
          await handlers.session.notifyManagedNativeCliProjectMembers({
            sessionId: projectId,
            text: summary,
            sender: { kind: 'system', name: 'Project Q&A summary', id: 'system:project-qa' },
            exceptAgentName: binding.agentId
          });
        }
        return { ok: true, requestId: result.requestId, answer: result.answer };
      },
      { body: contracts.projectAsk.body, response: contracts.projectAsk.response }
    )
    .post(
      '/internal/native-agent/project/read',
      ({ body, request }) => {
        const { binding } = requireManagedBinding(request);
        const projectId = body.projectId ?? binding.projectId;
        if (binding.projectId !== projectId) {
          throw new HandlerError('forbidden', 'project id does not match managed runtime', 'PROJECT_MISMATCH');
        }
        const transcriptTargetId = projectId;
        const messages = store.listMessages(transcriptTargetId, {
          limit: body.limit ?? 50,
          threadId: body.threadId,
          before: body.before,
          after: body.after,
          around: body.around,
          latest: !body.before && !body.after && !body.around
        });
        if (!body.threadId && !body.before && !body.after && !body.around) {
          const visibleSeq = store.maxMessageSeq(transcriptTargetId);
          if (visibleSeq > 0) store.markNativeCliInboxVisible(binding.nativeCliSessionId, visibleSeq);
        }
        return { messages };
      },
      { body: contracts.projectRead.body, response: contracts.projectRead.response }
    )
    .post(
      '/internal/native-agent/project/inbox',
      ({ body, request }) => {
        const { binding, nativeSession } = requireManagedBinding(request);
        const projectId = body?.projectId ?? binding.projectId;
        if (projectId !== binding.projectId) {
          throw new HandlerError('forbidden', 'project id does not match managed runtime', 'PROJECT_MISMATCH');
        }
        const nativeCliSessionId = binding.nativeCliSessionId;
        const items = store.listNativeCliInbox(nativeCliSessionId);
        const cursor = items.at(-1)?.seq ?? nativeSession.lastVisibleSeq;
        if (items.length > 0) store.markNativeCliInboxVisible(nativeCliSessionId, cursor);
        return { items, projectId, cursor };
      },
      { body: contracts.projectInbox.body, response: contracts.projectInbox.response }
    )
    .post(
      '/internal/native-agent/project/inbox/ack',
      ({ body, request }) => {
        const { binding } = requireManagedBinding(request);
        const projectId = body?.projectId ?? binding.projectId;
        if (projectId !== binding.projectId) {
          throw new HandlerError('forbidden', 'project id does not match managed runtime', 'PROJECT_MISMATCH');
        }
        const cursor = body?.cursor ?? store.maxMessageSeq(projectId);
        store.markNativeCliInboxConsumed(binding.nativeCliSessionId, cursor);
        return { ok: true, projectId, cursor };
      },
      { body: contracts.projectInboxAck.body, response: contracts.projectInboxAck.response }
    )
    .post(
      '/internal/native-agent/agent/send',
      async ({ body, request }) => {
        const { binding } = requireManagedBinding(request);
        const message = {
          id: newId('msg'),
          projectId: binding.projectId,
          nativeCliSessionId: binding.nativeCliSessionId,
          fromAgent: binding.agentId,
          peer: body.to,
          text: body.text,
          createdAt: new Date().toISOString()
        };
        store.insertNativeAgentDirectMessage(message);
        await handlers.session.notifyManagedNativeCliDirectMessage({
          sessionId: binding.projectId,
          fromAgentName: binding.agentId,
          to: body.to,
          text: body.text
        });
        return { ok: true, direct: true, message };
      },
      { body: contracts.agentSend.body, response: contracts.agentSend.response }
    )
    .post(
      '/internal/native-agent/agent/read',
      ({ body, request }) => {
        const { binding } = requireManagedBinding(request);
        const messages = store.listNativeAgentDirectMessages(binding.nativeCliSessionId, body.with, {
          before: body.before,
          after: body.after,
          limit: body.limit ?? 50
        });
        return { with: body.with, messages, before: body.before, after: body.after };
      },
      { body: contracts.agentRead.body, response: contracts.agentRead.response }
    )
    .get(
      '/internal/native-agent/runtime/info',
      ({ request }) => {
        const { binding, nativeSession } = requireManagedBinding(request);
        return {
          ...binding,
          serverUrl: new URL(request.url).origin,
          workdir: nativeSession.workingPath,
          providerSessionRef: nativeSession.providerSessionRef,
          lastDeliveredSeq: nativeSession.lastDeliveredSeq,
          lastVisibleSeq: nativeSession.lastVisibleSeq,
          pendingInboxCount: store.countNativeCliInbox(binding.nativeCliSessionId)
        };
      },
      { response: contracts.runtimeInfo.response }
    );
}
