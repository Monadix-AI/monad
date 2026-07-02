import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import { createHash, timingSafeEqual } from 'node:crypto';
import { daemonHttpContract, newId, type ProjectId } from '@monad/protocol';
import { Elysia } from 'elysia';

import { HandlerError } from '@/handlers/handler-error.ts';

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
          text: body.text
        });
        const messageId = completed.messageId ?? newId('msg');
        const createdAt = new Date().toISOString();
        store.insertMessage(messageId, transcriptTargetId, body.text, createdAt, 'assistant', {
          data: { agentName: binding.agentId, threadId: body.threadId, nativeCliSessionId: binding.nativeCliSessionId }
        });
        store.markNativeCliInboxConsumed(binding.nativeCliSessionId, store.maxMessageSeq(transcriptTargetId));
        await handlers.session.notifyManagedNativeCliProjectMembers({
          sessionId: transcriptTargetId,
          text: body.text,
          exceptAgentName: binding.agentId
        });
        return { ok: true, message: { id: messageId, projectId, text: body.text, createdAt } };
      },
      { body: contracts.projectPost.body, response: contracts.projectPost.response }
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
