import type { Logger } from '@monad/logger';
import type {
  LiveMeshSession,
  ManagedProjectLoopEventHandler,
  ManagedProjectOutputHandler
} from '#/services/mesh-agent/host/host-types.ts';
import type { MeshAgentOutputEvent, MeshAgentProviderAdapter } from '#/services/mesh-agent/types.ts';
import type { Store } from '#/store/db/index.ts';
import type { MeshAgentTargetId } from '#/store/db/mesh-sessions.ts';

import { MeshAgentEventLog } from '#/services/mesh-agent/host/event-log.ts';
import { meshAgentApprovalText } from '#/services/mesh-agent/host/host-helpers.ts';

export interface MeshAgentOutputPipelineContext {
  live: Map<string, LiveMeshSession>;
  store: Pick<
    Store,
    | 'getMeshSession'
    | 'updateMeshSessionRef'
    | 'hasUnconsumedMeshAgentInbox'
    | 'markMeshAgentInboxConsumed'
    | 'meshAgentInboxCursor'
  >;
  events: MeshAgentEventLog;
  stop(id: string): void;
  getManagedProjectOutputHandler(): ManagedProjectOutputHandler | null;
  getManagedProjectLoopEventHandler(): ManagedProjectLoopEventHandler | null;
  log: Logger;
}

interface AutopilotApprovalDecision {
  requestId: string;
  allow: boolean;
  reason: string;
}

function autopilotApprovalDecision(
  provider: string,
  requestId: string,
  payload: Record<string, unknown>
): AutopilotApprovalDecision {
  const blocksMonadHostEscape =
    provider === 'monad' &&
    (payload.key === 'host-control' || (payload.tool === 'code_execute' && payload.key === 'target:host'));
  return {
    requestId,
    allow: !blocksMonadHostEscape,
    reason: blocksMonadHostEscape ? 'Monad autopilot blocks host escape' : 'managed project MeshAgent autopilot'
  };
}

export class MeshAgentOutputPipeline {
  constructor(private readonly ctx: MeshAgentOutputPipelineContext) {}

  structuredEvent(
    transcriptTargetId: MeshAgentTargetId,
    id: string,
    adapter: MeshAgentProviderAdapter,
    event: MeshAgentOutputEvent,
    authAgentName: string
  ): void {
    const liveSession = this.ctx.live.get(id);
    if (liveSession?.runtimeRole === 'managed-project-agent') {
      this.ctx.getManagedProjectLoopEventHandler()?.({
        kind: 'output',
        sessionId: transcriptTargetId,
        meshSessionId: id,
        memberId: liveSession.agentName,
        event
      });
    }
    if (event.type === 'agent_message') {
      if (event.payload.final === true) {
        this.emitManagedProjectOutput(
          transcriptTargetId,
          id,
          typeof event.payload.text === 'string' ? event.payload.text : '',
          false,
          false
        );
      }
      return;
    }

    if (event.type === 'session_ref') {
      const providerSessionRef =
        typeof event.payload.providerSessionRef === 'string' ? event.payload.providerSessionRef : undefined;
      if (providerSessionRef) {
        const live = this.ctx.live.get(id);
        if (live) {
          live.providerSessionRef = providerSessionRef;
        }
        this.ctx.store.updateMeshSessionRef(id, providerSessionRef);
      }
      return;
    }

    if (event.type === 'connection_required') {
      const live = this.ctx.live.get(id);
      this.ctx.events.emit(transcriptTargetId, 'mesh.connection_required', {
        meshSessionId: id,
        agentName: live?.agentName ?? adapter.provider,
        authAgentName,
        provider: adapter.provider,
        code:
          typeof event.payload.code === 'string' && event.payload.code.length > 0
            ? event.payload.code
            : 'provider_connection_required',
        reason:
          typeof event.payload.reason === 'string'
            ? event.payload.reason
            : `${adapter.provider} requires reconnect in Studio`,
        reconnectIn: 'studio'
      });
      this.ctx.stop(id);
      return;
    }

    if (event.type === 'provider_error') {
      const message =
        typeof event.payload.message === 'string' ? event.payload.message : `${adapter.provider} provider error`;
      this.emitManagedProjectOutput(transcriptTargetId, id, message, true);
      return;
    }

    if (event.type === 'approval_requested') {
      const requestId =
        typeof event.payload.requestId === 'string' ? event.payload.requestId : String(event.payload.requestId);
      const live = this.ctx.live.get(id);
      if (live?.approvalMode === 'autopilot') {
        const text = meshAgentApprovalText(event);
        const decision = autopilotApprovalDecision(adapter.provider, requestId, event.payload);
        const resolution = live.sessionEventRuntime?.resolveApproval(decision);
        if (!resolution) {
          this.handleAutopilotResolutionFailure(
            transcriptTargetId,
            id,
            adapter,
            requestId,
            text,
            new Error('provider runtime does not support approval resolution')
          );
          return;
        }
        void resolution.catch((err) => {
          this.handleAutopilotResolutionFailure(transcriptTargetId, id, adapter, requestId, text, err);
        });
        this.ctx.log.debug(
          {
            sessionId: transcriptTargetId,
            event: 'mesh.managed_project_provider_approval_resolved',
            meshSessionId: id,
            provider: adapter.provider,
            requestId,
            text,
            allow: decision.allow
          },
          'managed native cli provider approval resolved'
        );
        return;
      }
      if (live?.pendingApprovals.has(requestId)) return;
      live?.pendingApprovals.set(requestId, event.payload);
      this.ctx.events.emit(transcriptTargetId, 'mesh.approval_requested', {
        meshSessionId: id,
        provider: adapter.provider,
        requestId,
        text: meshAgentApprovalText(event),
        data: event.payload
      });
      return;
    }

    if (event.type === 'approval_resolved') {
      const requestId =
        typeof event.payload.requestId === 'string' ? event.payload.requestId : String(event.payload.requestId);
      const live = this.ctx.live.get(id);
      if (!live?.pendingApprovals.has(requestId)) return;
      live.pendingApprovals.delete(requestId);
      this.ctx.events.emit(transcriptTargetId, 'mesh.approval_resolved', {
        meshSessionId: id,
        provider: adapter.provider,
        requestId,
        allow: event.payload.allow !== false,
        ...(typeof event.payload.reason === 'string' ? { reason: event.payload.reason } : {})
      });
    }
  }

  private handleAutopilotResolutionFailure(
    transcriptTargetId: MeshAgentTargetId,
    id: string,
    adapter: MeshAgentProviderAdapter,
    requestId: string,
    text: string,
    error: unknown
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.ctx.log.debug(
      {
        sessionId: transcriptTargetId,
        event: 'mesh.managed_project_provider_approval_resolution_error',
        meshSessionId: id,
        provider: adapter.provider,
        requestId,
        text,
        err: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
      },
      'managed native cli provider approval resolution failed'
    );
    this.emitManagedProjectOutput(
      transcriptTargetId,
      id,
      `Failed to resolve ${adapter.label} autopilot approval: ${message}`,
      true,
      false
    );
    this.ctx.stop(id);
  }

  emitManagedProjectOutput(
    transcriptTargetId: MeshAgentTargetId,
    id: string,
    text: string,
    error = false,
    post = true
  ): void {
    const live = this.ctx.live.get(id);
    const row = this.ctx.store.getMeshSession(id);
    const runtimeRole = live?.runtimeRole ?? row?.runtimeRole;
    if (runtimeRole !== 'managed-project-agent') return;
    if (post && !this.ctx.store.hasUnconsumedMeshAgentInbox(id)) return;
    const agentName = live?.agentName ?? row?.agentName;
    const managedProjectOutputHandler = this.ctx.getManagedProjectOutputHandler();
    if (!agentName || !managedProjectOutputHandler) return;
    // Consume only what the agent actually saw in its input (visible), never items merely
    // delivered mid-turn (busy notice sent without the message body) — those must survive
    // this turn's settle so a later wake or `project_inbox_check` can still surface them.
    // The managed mesh cursor is frozen, so the visible watermark comes from the SessionBinding.
    const cursor = this.ctx.store.meshAgentInboxCursor(id).visibleSeq;
    if (cursor > 0) this.ctx.store.markMeshAgentInboxConsumed(id, cursor);
    void Promise.resolve(
      managedProjectOutputHandler({
        sessionId: transcriptTargetId,
        meshSessionId: id,
        agentName,
        text,
        error,
        post
      })
    ).catch((err: unknown) => {
      this.ctx.log.debug(
        {
          sessionId: transcriptTargetId,
          event: 'mesh.managed_project_output_error',
          meshSessionId: id,
          agentName,
          err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err)
        },
        'managed native cli provider output failed to project'
      );
    });
  }
}
