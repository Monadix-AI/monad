import type {
  NativeAgentProjectPlanAddRequest,
  NativeAgentProjectPlanDeleteRequest,
  NativeAgentProjectPlanDeleteResponse,
  NativeAgentProjectPlanListResponse,
  NativeAgentProjectPlanTodoResponse,
  NativeAgentProjectPlanUpdateRequest
} from '@monad/protocol';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';
import type { SessionPlanActor } from '#/store/db/session-plan-mutations.ts';
import type { NativeAgentRuntimeBinding } from './runtime.ts';

import {
  addPlanTodoCore,
  deletePlanTodoCore,
  listPlanCore,
  updatePlanTodoCore
} from '#/handlers/session/handlers/session-plan.ts';
import { buildOperationSource } from '#/handlers/session/origin.ts';

/**
 * The managed-agent `SessionPlanActor`: always `project_member`, attributed to the calling
 * runtime's own bound `projectMemberId` — never the request body, which never carries one (see
 * `nativeAgentProjectPlan*RequestSchema`'s `sessionId` omission for the parallel reasoning).
 * `instanceId: binding.meshSessionId` keeps the audit trail able to distinguish which concrete
 * runtime made the call, same as the durable delivery/audit fields elsewhere in this cutover.
 */
function managedPlanActor(binding: NativeAgentRuntimeBinding): SessionPlanActor {
  return {
    kind: 'project_member',
    attribution: {
      source: buildOperationSource({
        transport: 'http',
        surface: 'automation',
        client: 'managed-agent',
        instanceId: binding.meshSessionId
      }),
      projectMemberId: binding.projectMemberId
    }
  };
}

export interface NativeAgentProjectPlanApi {
  list(args: { binding: NativeAgentRuntimeBinding }): NativeAgentProjectPlanListResponse;
  add(args: {
    body: NativeAgentProjectPlanAddRequest;
    binding: NativeAgentRuntimeBinding;
  }): NativeAgentProjectPlanTodoResponse;
  update(args: {
    body: NativeAgentProjectPlanUpdateRequest;
    binding: NativeAgentRuntimeBinding;
  }): NativeAgentProjectPlanTodoResponse;
  delete(args: {
    body: NativeAgentProjectPlanDeleteRequest;
    binding: NativeAgentRuntimeBinding;
  }): NativeAgentProjectPlanDeleteResponse;
}

export function createNativeAgentProjectPlanApi(
  handlers: ReturnType<typeof createDaemonHandlers>
): NativeAgentProjectPlanApi {
  const store = handlers._nativeAgentStore;
  const bus = handlers._nativeAgentEventBus;
  return {
    list({ binding }) {
      return listPlanCore(store, binding.sessionId);
    },
    add({ body, binding }) {
      return addPlanTodoCore(store, bus, binding.sessionId, managedPlanActor(binding), body);
    },
    update({ body, binding }) {
      const { todoId, ...rest } = body;
      return updatePlanTodoCore(store, bus, binding.sessionId, managedPlanActor(binding), todoId, rest);
    },
    delete({ body, binding }) {
      return deletePlanTodoCore(store, bus, binding.sessionId, managedPlanActor(binding), body.todoId, body);
    }
  };
}
