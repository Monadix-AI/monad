import type {
  MeshAgentProviderAdapter,
  MeshAgentProviderEventPageRequestContext,
  MeshAgentRuntimeHandle
} from '@monad/sdk-atom';

import { MeshAgentError } from '@monad/sdk-atom';

import { compactObject } from '../adapter-shared.ts';
import { jsonRpcNotification, jsonRpcRequest, jsonRpcResponse, jsonRpcResponseId } from '../jsonrpc.ts';
import { resizePty, sendPtyInput, stopPty } from '../pty.ts';
import { buildCodexInitialTurnsPage } from './event-pages.ts';
import { codexRuntimeState } from './state.ts';

export function initializeCodex(
  handle: Parameters<NonNullable<MeshAgentProviderAdapter['initialize']>>[0],
  context: Parameters<NonNullable<MeshAgentProviderAdapter['initialize']>>[1]
): void {
  if (handle.launchMode !== 'app-server') return;
  if (!handle.appServer) throw new Error('MeshAgent session has no app-server initialization bridge');
  const state = codexRuntimeState(handle);
  const initializeId = handle.nextRequestId?.() ?? 0;
  const threadId = handle.nextRequestId?.() ?? 1;
  handle.pendingRequests?.set(initializeId, 'initialize');
  const modelParam = context.modelId ?? context.modelName;
  handle.pendingRequests?.set(threadId, context.providerSessionRef ? 'threadResume' : 'thread');
  const threadParams = context.providerSessionRef
    ? {
        threadId: context.providerSessionRef,
        cwd: context.workingPath,
        ...(modelParam ? { model: modelParam } : {}),
        ...(context.reasoningEffort ? { modelReasoningEffort: context.reasoningEffort } : {}),
        ...(context.developerInstructions ? { developerInstructions: context.developerInstructions } : {}),
        excludeTurns: true,
        initialTurnsPage: buildCodexInitialTurnsPage()
      }
    : {
        cwd: context.workingPath,
        ...(modelParam ? { model: modelParam } : {}),
        ...(context.reasoningEffort ? { modelReasoningEffort: context.reasoningEffort } : {}),
        ...(context.developerInstructions ? { developerInstructions: context.developerInstructions } : {})
      };
  const threadFrame = context.providerSessionRef
    ? jsonRpcRequest('thread/resume', threadId, threadParams)
    : jsonRpcRequest('thread/start', threadId, threadParams);
  state.threadResumeRetry = context.providerSessionRef ? { params: threadParams, attempts: 0 } : undefined;
  // Park the thread request until the initialize response arrives (see parseCodexClientResponse); send
  // only the handshake now. A handle with no by-id ledger (single-shot probes) can't route the
  // response back, so fall back to the original send-it-all ordering there.
  state.deferredThreadFrame = threadFrame;
  const handshake = [
    jsonRpcRequest('initialize', initializeId, {
      clientInfo: { name: 'monad', title: 'Monad', version: '0.1.0' },
      // experimentalApi is required for the v2 item/* streaming surface; requestAttestation is sent
      // explicitly (the capability is required by the protocol) but left off — we don't proxy
      // upstream attestation. Any server-initiated request we don't handle is auto-declined in
      // parseOutput, so opting into the experimental surface can't wedge the connection.
      capabilities: { experimentalApi: true, requestAttestation: false }
    }),
    jsonRpcNotification('initialized')
  ];
  const frames = handle.pendingRequests ? handshake : [...handshake, threadFrame];
  if (!handle.pendingRequests) state.deferredThreadFrame = undefined;
  for (const frame of frames) handle.appServer.send(frame);
}

export function sendCodexInput(handle: Parameters<MeshAgentProviderAdapter['sendInput']>[0], input: string): void {
  if (handle.launchMode !== 'app-server') {
    sendPtyInput(handle, input);
    return;
  }
  if (!handle.appServer) throw new Error('MeshAgent session has no app-server input bridge');
  if (!handle.providerSessionRef) throw new Error('MeshAgent app-server thread is not ready');
  const state = codexRuntimeState(handle);
  state.lastTurnInput = input;
  state.turnRecoveries = 0;
  const turnId = handle.nextRequestId?.() ?? Date.now();
  handle.pendingRequests?.set(turnId, 'turn');
  handle.appServer.send(
    jsonRpcRequest('turn/start', turnId, {
      threadId: handle.providerSessionRef,
      input: [{ type: 'text', text: input }]
    })
  );
}

export function interruptCodex(handle: Parameters<NonNullable<MeshAgentProviderAdapter['interrupt']>>[0]): void {
  if (handle.launchMode !== 'app-server' || !handle.appServer) return;
  const currentTurnId = codexRuntimeState(handle).currentTurnId;
  if (!handle.providerSessionRef || !currentTurnId) return;
  handle.appServer.send(
    jsonRpcRequest('turn/interrupt', handle.nextRequestId?.() ?? Date.now(), {
      threadId: handle.providerSessionRef,
      turnId: currentTurnId
    })
  );
}

export function steerCodex(handle: Parameters<NonNullable<MeshAgentProviderAdapter['steer']>>[0], input: string): void {
  if (handle.launchMode !== 'app-server' || !handle.appServer) return;
  const currentTurnId = codexRuntimeState(handle).currentTurnId;
  if (!handle.providerSessionRef || !currentTurnId) return;
  handle.appServer.send(
    jsonRpcRequest('turn/steer', handle.nextRequestId?.() ?? Date.now(), {
      threadId: handle.providerSessionRef,
      expectedTurnId: currentTurnId,
      input: [{ type: 'text', text: input }]
    })
  );
}

export function requestCodexEventPage(
  handle: MeshAgentRuntimeHandle,
  request: MeshAgentProviderEventPageRequestContext['request']
): string | number {
  if (handle.launchMode !== 'app-server') {
    throw new MeshAgentError('unsupported_capability', 'Codex event paging requires app-server mode');
  }
  if (!handle.appServer)
    throw new MeshAgentError('provider_protocol_error', 'MeshAgent session has no app-server event bridge');
  if (!handle.providerSessionRef) {
    throw new MeshAgentError('provider_not_logged_in', 'MeshAgent app-server thread is not ready');
  }
  const id = handle.nextRequestId?.() ?? Date.now();
  handle.pendingRequests?.set(id, 'eventPage');
  handle.appServer.send(
    jsonRpcRequest(
      'thread/turns/list',
      id,
      compactObject({
        threadId: handle.providerSessionRef,
        cursor: request.before,
        limit: request.limit,
        sortDirection: request.sortDirection,
        itemsView: request.itemsView
      })
    )
  );
  return id;
}

function codexApprovalResult(request: Record<string, unknown> | undefined, allow: boolean): Record<string, unknown> {
  const kind = typeof request?.kind === 'string' ? request.kind : undefined;
  if (kind === 'execCommand' || kind === 'applyPatch') {
    return { decision: allow ? 'approved' : 'denied' };
  }
  if (kind === 'permissions') {
    return allow ? { permissions: {}, scope: 'turn' } : { permissions: {}, scope: 'turn', strictAutoReview: true };
  }
  return { decision: allow ? 'accept' : 'decline' };
}

// Codex server→client request ids are JSON-RPC RequestIds (often numeric). The event pipeline
// stringifies the id for transport to the client, so echoing that string back would break codex's
// numeric-id correlation and leave the approval hanging. `jsonRpcResponseId` recovers the verbatim id
// from the stored request payload, falling back to the (stringified) id only when it is absent.
function buildCodexApprovalResponse(
  requestId: string,
  request: Record<string, unknown> | undefined,
  allow: boolean
): string {
  return jsonRpcResponse(jsonRpcResponseId(request?.requestId, requestId), codexApprovalResult(request, allow));
}

export function resolveCodexApproval(
  handle: Parameters<MeshAgentProviderAdapter['resolveApproval']>[0],
  resolution: Parameters<MeshAgentProviderAdapter['resolveApproval']>[1]
): void {
  if (handle.launchMode !== 'app-server') return;
  if (!handle.appServer) throw new Error('MeshAgent session has no app-server approval bridge');
  handle.appServer.send(buildCodexApprovalResponse(resolution.requestId, resolution.request, resolution.allow));
}

export function resizeCodex(
  handle: Parameters<MeshAgentProviderAdapter['resize']>[0],
  cols: number,
  rows: number
): void {
  if (handle.launchMode === 'app-server') return;
  resizePty(handle, cols, rows);
}

export function stopCodex(handle: Parameters<MeshAgentProviderAdapter['stop']>[0]): void {
  if (handle.launchMode === 'app-server') {
    handle.appServer?.close();
    handle.kill('SIGTERM');
    return;
  }
  stopPty(handle);
}
