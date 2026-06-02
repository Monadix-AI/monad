import type {
  NativeAgentProjectAskCancelRequest,
  NativeAgentProjectAskCancelResponse,
  NativeAgentProjectAskRequest,
  NativeAgentProjectAskResponse,
  NativeAgentProjectInboxAckRequest,
  NativeAgentProjectInboxAckResponse,
  NativeAgentProjectInboxRequest,
  NativeAgentProjectInboxResponse,
  NativeAgentProjectPlanAddRequest,
  NativeAgentProjectPlanDeleteRequest,
  NativeAgentProjectPlanDeleteResponse,
  NativeAgentProjectPlanListResponse,
  NativeAgentProjectPlanTodoResponse,
  NativeAgentProjectPlanUpdateRequest,
  NativeAgentProjectPostRequest,
  NativeAgentProjectPostResponse,
  NativeAgentProjectReadRequest,
  NativeAgentProjectReadResponse,
  NativeAgentReadRequest,
  NativeAgentReadResponse,
  NativeAgentSendRequest,
  NativeAgentSendResponse
} from '@monad/protocol';
import type { NativeAgentRuntimeBinding } from './runtime.ts';

export interface NativeAgentProjectApi {
  post(args: {
    body: NativeAgentProjectPostRequest;
    binding: NativeAgentRuntimeBinding;
    attachmentRoots: readonly string[];
  }): Promise<NativeAgentProjectPostResponse>;
  ask(args: {
    body: NativeAgentProjectAskRequest;
    binding: NativeAgentRuntimeBinding;
    signal?: AbortSignal;
  }): Promise<NativeAgentProjectAskResponse>;
  cancel(args: {
    body: NativeAgentProjectAskCancelRequest;
    binding: NativeAgentRuntimeBinding;
  }): Promise<NativeAgentProjectAskCancelResponse>;
  read(args: {
    body: NativeAgentProjectReadRequest;
    binding: NativeAgentRuntimeBinding;
  }): NativeAgentProjectReadResponse;
  inbox(args: {
    body: NativeAgentProjectInboxRequest;
    binding: NativeAgentRuntimeBinding;
    lastVisibleSeq: number;
  }): NativeAgentProjectInboxResponse;
  ack(args: {
    body: NativeAgentProjectInboxAckRequest;
    binding: NativeAgentRuntimeBinding;
  }): NativeAgentProjectInboxAckResponse;
}

export interface NativeAgentDirectApi {
  send(args: {
    body: NativeAgentSendRequest;
    binding: NativeAgentRuntimeBinding;
    attachmentRoots: readonly string[];
  }): Promise<NativeAgentSendResponse>;
  read(args: { body: NativeAgentReadRequest; binding: NativeAgentRuntimeBinding }): NativeAgentReadResponse;
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

export interface NativeAgentApi {
  project: NativeAgentProjectApi;
  direct: NativeAgentDirectApi;
  plan: NativeAgentProjectPlanApi;
}

export function createNativeAgentApiRegistry() {
  let project: NativeAgentProjectApi | undefined;
  let direct: NativeAgentDirectApi | undefined;
  let plan: NativeAgentProjectPlanApi | undefined;
  return {
    registerProject(capabilities: NativeAgentProjectApi): void {
      project = capabilities;
    },
    registerDirect(capabilities: NativeAgentDirectApi): void {
      direct = capabilities;
    },
    registerPlan(capabilities: NativeAgentProjectPlanApi): void {
      plan = capabilities;
    },
    resolve(): NativeAgentApi {
      if (!project) throw new Error('native agent project capabilities are not registered');
      if (!direct) throw new Error('native agent direct capabilities are not registered');
      if (!plan) throw new Error('native agent plan capabilities are not registered');
      return { project, direct, plan };
    }
  };
}
