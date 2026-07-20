import type { Logger } from '@monad/logger';
import type { LiveMeshSession, ManagedProjectOutputHandler } from '#/services/mesh-agent/host/host-types.ts';
import type { MeshAgentOutputEvent, MeshAgentProviderAdapter } from '#/services/mesh-agent/types.ts';
import type { Store } from '#/store/db/index.ts';
import type { MeshAgentTargetId } from '#/store/db/mesh-sessions.ts';

import { MeshAgentEventLog } from '#/services/mesh-agent/host/event-log.ts';
import { meshAgentApprovalText } from '#/services/mesh-agent/host/host-helpers.ts';

export interface MeshAgentOutputPipelineContext {
  live: Map<string, LiveMeshSession>;
  store: Pick<
    Store,
    'getMeshSession' | 'updateMeshSessionRef' | 'hasUnconsumedMeshAgentInbox' | 'markMeshAgentInboxConsumed'
  >;
  events: MeshAgentEventLog;
  stop(id: string): void;
  getManagedProjectOutputHandler(): ManagedProjectOutputHandler | null;
  log: Logger;
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
    if (event.type === 'agent_message') {
      // A managed provider's own message is diagnostic output — observable through the mesh_agent
      // output card, never auto-posted to the Workplace Project wall. A reply reaches the room only
      // when the agent explicitly posts via the bridge (`monad project post`), which the wake notice
      // instructs it to do. This keeps every provider consistent (codex never carried a terminal
      // `final` marker) and avoids double-posting the same text via both paths. Errors still surface
      // below via the provider_error branch.
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
      // Autopilot managed sessions auto-deny any approval that leaks past the skip flag. A managed
      // session that delegates approvals (autopilot off + resolvable adapter) instead falls through
      // to the same projection path interactive sessions use — monad is only the UI proxy.
      if (live?.runtimeRole === 'managed-project-agent' && !live.proxyApprovals) {
        const text = meshAgentApprovalText(event);
        void live.sessionEventRuntime
          ?.resolveApproval({
            requestId,
            allow: false,
            reason: 'managed project MeshAgent provider approvals are disabled'
          })
          .catch((err) => {
            this.ctx.log.debug(
              {
                sessionId: transcriptTargetId,
                event: 'mesh.managed_project_provider_approval_suppress_error',
                meshSessionId: id,
                provider: adapter.provider,
                requestId,
                text,
                err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err)
              },
              'managed native cli provider approval suppress failed'
            );
          });
        this.ctx.log.debug(
          {
            sessionId: transcriptTargetId,
            event: 'mesh.managed_project_provider_approval_suppressed',
            meshSessionId: id,
            provider: adapter.provider,
            requestId,
            text
          },
          'managed native cli provider approval suppressed'
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
    // this turn's settle so a later wake or `monad project inbox` can still surface them.
    const cursor = row?.lastVisibleSeq ?? 0;
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
