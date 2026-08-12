import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { daemonHttpContract, filePreviewTargetSchema } from '@monad/protocol';
import { Elysia } from 'elysia';

import {
  createNativeAgentAttachmentReader,
  createNativeAgentAttachmentResolver
} from '#/services/native-agent/attachments.ts';
import { createDefaultNativeAgentApi } from '#/services/native-agent/default-capabilities.ts';
import { createNativeAgentRuntimeService } from '#/services/native-agent/runtime.ts';

export function createNativeAgentController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const store = handlers._nativeAgentStore;
  const contracts = daemonHttpContract.nativeAgent;
  const runtime = createNativeAgentRuntimeService(handlers);
  const requireManagedBinding = (request: Request) => runtime.requireManagedBinding(request.headers);
  const resolveAttachmentPayload = createNativeAgentAttachmentResolver(store);
  const attachmentRoots = handlers._nativeAgentAttachmentRoots;
  const attachmentReader = createNativeAgentAttachmentReader(store);
  const capabilities = createDefaultNativeAgentApi(handlers, resolveAttachmentPayload);
  const rootsForManagedBinding = (
    binding: ReturnType<typeof requireManagedBinding>['binding'],
    workingPath: string
  ): string[] =>
    attachmentRoots({ sessionId: binding.sessionId, projectMemberId: binding.projectMemberId, workingPath });
  return new Elysia({ tags: ['http-only'] })
    .post(
      '/internal/native-agent/project/post',
      async ({ body, request }) => {
        const { binding, nativeSession } = requireManagedBinding(request);
        return capabilities.project.post({
          body,
          binding,
          attachmentRoots: rootsForManagedBinding(binding, nativeSession.workingPath)
        });
      },
      { body: contracts.projectPost.body, response: contracts.projectPost.response }
    )
    .post(
      '/internal/native-agent/project/ask',
      async ({ body, request, server }) => {
        const { binding } = requireManagedBinding(request);
        server?.timeout(request, 0);
        return capabilities.project.ask({
          body,
          binding,
          signal: request.signal
        });
      },
      { body: contracts.projectAsk.body, response: contracts.projectAsk.response }
    )
    .post(
      '/internal/native-agent/project/ask/cancel',
      async ({ body, request }) => {
        const { binding } = requireManagedBinding(request);
        return capabilities.project.cancel({ body, binding });
      },
      { body: contracts.projectAskCancel.body, response: contracts.projectAskCancel.response }
    )
    .post(
      '/internal/native-agent/project/read',
      ({ body, request }) => {
        const { binding } = requireManagedBinding(request);
        return capabilities.project.read({ body, binding });
      },
      { body: contracts.projectRead.body, response: contracts.projectRead.response }
    )
    .post(
      '/internal/native-agent/project/inbox',
      ({ body, request }) => {
        const { binding, nativeSession } = requireManagedBinding(request);
        return capabilities.project.inbox({
          body,
          binding,
          lastVisibleSeq: nativeSession.lastVisibleSeq
        });
      },
      { body: contracts.projectInbox.body, response: contracts.projectInbox.response }
    )
    .post(
      '/internal/native-agent/project/inbox/ack',
      ({ body, request }) => {
        const { binding } = requireManagedBinding(request);
        return capabilities.project.ack({ body, binding });
      },
      { body: contracts.projectInboxAck.body, response: contracts.projectInboxAck.response }
    )
    .post(
      '/internal/native-agent/agent/send',
      async ({ body, request }) => {
        const { binding, nativeSession } = requireManagedBinding(request);
        return capabilities.direct.send({
          body,
          binding,
          attachmentRoots: rootsForManagedBinding(binding, nativeSession.workingPath)
        });
      },
      { body: contracts.agentSend.body, response: contracts.agentSend.response }
    )
    .post(
      '/internal/native-agent/agent/read',
      ({ body, request }) => {
        const { binding } = requireManagedBinding(request);
        return capabilities.direct.read({ body, binding });
      },
      { body: contracts.agentRead.body, response: contracts.agentRead.response }
    )
    .get('/file-preview', async ({ request }) => {
      const url = new URL(request.url);
      const attachmentId = url.searchParams.get('attachmentId');
      const path = url.searchParams.get('path');
      const sessionId = url.searchParams.get('sessionId');
      const projectMemberId = url.searchParams.get('projectMemberId');
      const target = filePreviewTargetSchema.parse(
        attachmentId ? { attachmentId } : { path, sessionId, projectMemberId }
      );
      const roots =
        'path' in target
          ? attachmentRoots({ sessionId: target.sessionId, projectMemberId: target.projectMemberId })
          : [];
      return attachmentReader.preview(
        target,
        {
          download: url.searchParams.get('download') === '1',
          inline: url.searchParams.get('inline') === '1'
        },
        roots
      );
    })
    .get(
      '/internal/native-agent/session/members',
      async ({ request }) => {
        const { binding } = requireManagedBinding(request);
        return handlers._nativeAgentSessionMembers.list(binding.sessionId, binding.projectMemberId);
      },
      { response: contracts.sessionMembers.response }
    )
    .get(
      '/internal/native-agent/runtime/info',
      ({ request }) => {
        const { binding, nativeSession } = requireManagedBinding(request);
        return runtime.info({ binding, nativeSession, serverUrl: new URL(request.url).origin });
      },
      { response: contracts.runtimeInfo.response }
    )
    .get(
      '/internal/native-agent/project/plan',
      ({ request }) => {
        const { binding } = requireManagedBinding(request);
        return capabilities.plan.list({ binding });
      },
      { response: contracts.planList.response }
    )
    .post(
      '/internal/native-agent/project/plan/todos',
      ({ body, request }) => {
        const { binding } = requireManagedBinding(request);
        return capabilities.plan.add({ body, binding });
      },
      { body: contracts.planAdd.body, response: contracts.planAdd.response }
    )
    .post(
      '/internal/native-agent/project/plan/todos/update',
      ({ body, request }) => {
        const { binding } = requireManagedBinding(request);
        return capabilities.plan.update({ body, binding });
      },
      { body: contracts.planUpdate.body, response: contracts.planUpdate.response }
    )
    .post(
      '/internal/native-agent/project/plan/todos/delete',
      ({ body, request }) => {
        const { binding } = requireManagedBinding(request);
        return capabilities.plan.delete({ body, binding });
      },
      { body: contracts.planDelete.body, response: contracts.planDelete.response }
    );
}
