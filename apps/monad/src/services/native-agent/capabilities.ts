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
  NativeAgentReadRequest,
  NativeAgentReadResponse,
  NativeAgentSendRequest,
  NativeAgentSendResponse
} from '@monad/protocol';
import type { NativeAgentRuntimeBinding } from './runtime.ts';

export interface NativeAgentProjectCapabilities {
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

export interface NativeAgentDirectCapabilities {
  send(args: {
    body: NativeAgentSendRequest;
    binding: NativeAgentRuntimeBinding;
    attachmentRoots: readonly string[];
  }): Promise<NativeAgentSendResponse>;
  read(args: { body: NativeAgentReadRequest; binding: NativeAgentRuntimeBinding }): NativeAgentReadResponse;
}

export interface NativeAgentCapabilities {
  project: NativeAgentProjectCapabilities;
  direct: NativeAgentDirectCapabilities;
}

export function createNativeAgentCapabilityRegistry() {
  let project: NativeAgentProjectCapabilities | undefined;
  let direct: NativeAgentDirectCapabilities | undefined;
  return {
    registerProject(capabilities: NativeAgentProjectCapabilities): void {
      project = capabilities;
    },
    registerDirect(capabilities: NativeAgentDirectCapabilities): void {
      direct = capabilities;
    },
    resolve(): NativeAgentCapabilities {
      if (!project) throw new Error('native agent project capabilities are not registered');
      if (!direct) throw new Error('native agent direct capabilities are not registered');
      return { project, direct };
    }
  };
}
