import type { AgentSessionSnapshot, NativeAgentDeliveryId, SessionId } from '@monad/protocol';
import type { MeshAgentOutputEvent } from '@monad/sdk-atom';
import type { EventBus } from '#/services/event-bus.ts';
import type { SessionEventRuntimeSnapshot } from '#/services/mesh-agent/session-event-runtime/types.ts';
import type { Store } from '#/store/db/index.ts';

import { agentSessionSnapshotSchema } from '@monad/protocol';

import { makeEvent } from '#/services/event-bus.ts';

interface PersistedAgentSessionState {
  activeDeliveryIds: NativeAgentDeliveryId[];
  snapshot: AgentSessionSnapshot;
}

interface LifecycleIdentity {
  sessionId: SessionId;
  memberId: string;
}

interface LifecycleOptions {
  store: Pick<Store, 'getSessionMember' | 'updateSessionMemberData'>;
  bus: EventBus;
  now?: () => string;
}

function initialSnapshot(identity: LifecycleIdentity, at: string): AgentSessionSnapshot {
  return {
    id: `${identity.sessionId}:${identity.memberId}`,
    transcriptTargetId: identity.sessionId,
    memberInstanceId: identity.memberId,
    revision: 0,
    lifecycle: 'active',
    connection: 'inactive',
    loop: {
      state: 'idle',
      pendingTurnCount: 0,
      enteredAt: at,
      activeToolCalls: []
    }
  };
}

function persistedState(value: unknown, identity: LifecycleIdentity, at: string): PersistedAgentSessionState {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const candidate = value as { activeDeliveryIds?: unknown; snapshot?: unknown };
    const snapshot = agentSessionSnapshotSchema.safeParse(candidate.snapshot);
    const deliveryIds = Array.isArray(candidate.activeDeliveryIds)
      ? candidate.activeDeliveryIds.filter(
          (id): id is NativeAgentDeliveryId => typeof id === 'string' && id.startsWith('deliv_')
        )
      : [];
    if (snapshot.success) return { activeDeliveryIds: deliveryIds, snapshot: snapshot.data };
  }
  return { activeDeliveryIds: [], snapshot: initialSnapshot(identity, at) };
}

function outputCallId(event: MeshAgentOutputEvent): string {
  const value = event.payload.callId;
  return value === undefined ? 'provider-tool' : String(value);
}

export class ManagedAgentSessionLifecycle {
  private readonly now: () => string;

  constructor(private readonly options: LifecycleOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  snapshot(sessionId: string, memberId: string): AgentSessionSnapshot | undefined {
    const member = this.options.store.getSessionMember(sessionId, memberId);
    if (member?.type !== 'mesh-agent') return undefined;
    return persistedState(
      member.data.agentSessionState,
      { sessionId: sessionId as SessionId, memberId },
      member.updatedAt
    ).snapshot;
  }

  queue(identity: LifecycleIdentity & { deliveryId: NativeAgentDeliveryId }): AgentSessionSnapshot | undefined {
    return this.change(identity, (state, at) => {
      if (state.activeDeliveryIds.includes(identity.deliveryId)) return;
      state.activeDeliveryIds.push(identity.deliveryId);
      const loop = state.snapshot.loop;
      state.snapshot.lifecycle = state.snapshot.lifecycle === 'released' ? 'resuming' : state.snapshot.lifecycle;
      state.snapshot.termination = undefined;
      state.snapshot.loop = {
        ...loop,
        state: loop.state === 'idle' ? 'queued' : loop.state,
        pendingTurnCount: state.activeDeliveryIds.length,
        enteredAt: loop.state === 'idle' ? at : loop.enteredAt
      };
    });
  }

  startTurn(
    identity: LifecycleIdentity & { deliveryId: NativeAgentDeliveryId; runtimeId?: `mesh_${string}` }
  ): AgentSessionSnapshot | undefined {
    return this.change(identity, (state, at) => {
      if (!state.activeDeliveryIds.includes(identity.deliveryId)) state.activeDeliveryIds.push(identity.deliveryId);
      const loop = state.snapshot.loop;
      if (loop.state === 'running' && loop.turnId === identity.deliveryId) return;
      state.snapshot.lifecycle = 'active';
      if (identity.runtimeId) state.snapshot.runtimeId = identity.runtimeId;
      state.snapshot.loop = {
        state: 'running',
        phase: 'waiting-provider',
        turnId: identity.deliveryId,
        pendingTurnCount: state.activeDeliveryIds.length,
        enteredAt: at,
        activeToolCalls: loop.activeToolCalls
      };
    });
  }

  settleTurn(identity: LifecycleIdentity & { deliveryId: NativeAgentDeliveryId }): AgentSessionSnapshot | undefined {
    return this.change(identity, (state, at) => {
      const index = state.activeDeliveryIds.indexOf(identity.deliveryId);
      if (index === -1) return;
      state.activeDeliveryIds.splice(index, 1);
      const pendingTurnCount = state.activeDeliveryIds.length;
      state.snapshot.loop = {
        state: pendingTurnCount > 0 ? 'queued' : 'idle',
        pendingTurnCount,
        enteredAt: at,
        activeToolCalls: []
      };
    });
  }

  applyOutputEvent(identity: LifecycleIdentity & { event: MeshAgentOutputEvent }): AgentSessionSnapshot | undefined {
    return this.change(identity, (state, at) => {
      const { event } = identity;
      const loop = state.snapshot.loop;
      if (event.type === 'connection_required') {
        state.activeDeliveryIds = [];
        state.snapshot.lifecycle = 'released';
        state.snapshot.connection = 'inactive';
        state.snapshot.loop = { state: 'idle', pendingTurnCount: 0, enteredAt: at, activeToolCalls: [] };
        return;
      }
      if (state.activeDeliveryIds.length === 0) return;
      if (event.type === 'tool_call') {
        const toolCallId = outputCallId(event);
        if (loop.activeToolCalls.some((call) => call.toolCallId === toolCallId)) return;
        state.snapshot.loop = {
          ...loop,
          state: 'running',
          phase: 'using-tools',
          activeToolCalls: [
            ...loop.activeToolCalls,
            {
              toolCallId,
              tool: typeof event.payload.tool === 'string' ? event.payload.tool : 'tool',
              startedAt: at
            }
          ]
        };
        return;
      }
      if (event.type === 'tool_result') {
        const toolCallId = outputCallId(event);
        const activeToolCalls = loop.activeToolCalls.filter((call) => call.toolCallId !== toolCallId);
        if (activeToolCalls.length === loop.activeToolCalls.length) return;
        state.snapshot.loop = {
          ...loop,
          state: 'running',
          phase: activeToolCalls.length > 0 ? 'using-tools' : 'waiting-provider',
          activeToolCalls
        };
        return;
      }
      if (event.type === 'agent_message') {
        if (loop.state === 'running' && loop.phase === 'answering') return;
        state.snapshot.loop = { ...loop, state: 'running', phase: 'answering' };
        return;
      }
      if (event.type === 'approval_requested') {
        if (loop.state === 'blocked' && loop.phase === 'awaiting-approval') return;
        state.snapshot.loop = { ...loop, state: 'blocked', phase: 'awaiting-approval' };
        return;
      }
      if (event.type === 'approval_resolved') {
        if (loop.state !== 'blocked' || loop.phase !== 'awaiting-approval') return;
        state.snapshot.loop = {
          ...loop,
          state: 'running',
          phase: loop.activeToolCalls.length > 0 ? 'using-tools' : 'waiting-provider'
        };
      }
    });
  }

  applyRuntimeSnapshot(
    identity: LifecycleIdentity & { runtimeId: `mesh_${string}`; snapshot: SessionEventRuntimeSnapshot }
  ): AgentSessionSnapshot | undefined {
    return this.change(identity, (state, at) => {
      const runtime = identity.snapshot;
      state.snapshot.runtimeId = identity.runtimeId;
      state.snapshot.providerSessionRef = runtime.providerSessionRef;
      state.snapshot.connection = runtime.connection.state;
      if (runtime.lifecycle.state === 'terminal') {
        state.activeDeliveryIds = [];
        state.snapshot.lifecycle = 'terminated';
        state.snapshot.connection = 'inactive';
        state.snapshot.loop = { state: 'idle', pendingTurnCount: 0, enteredAt: at, activeToolCalls: [] };
        state.snapshot.termination = {
          reason:
            runtime.lifecycle.termination.kind === 'failed'
              ? 'failed'
              : runtime.lifecycle.termination.kind === 'stopped'
                ? 'stopped'
                : 'completed',
          at: runtime.lifecycle.termination.at,
          ...(runtime.lifecycle.termination.error ? { error: runtime.lifecycle.termination.error } : {})
        };
        return;
      }
      if (runtime.activity.state === 'suspended') {
        state.snapshot.lifecycle = 'released';
        state.snapshot.connection = 'inactive';
        state.snapshot.loop = {
          state: state.activeDeliveryIds.length > 0 ? 'queued' : 'idle',
          pendingTurnCount: state.activeDeliveryIds.length,
          enteredAt: runtime.activity.suspendedAt,
          activeToolCalls: []
        };
        return;
      }
      if (runtime.lifecycle.state === 'starting') {
        state.snapshot.lifecycle = state.activeDeliveryIds.length > 0 ? 'resuming' : 'initializing';
        return;
      }
      state.snapshot.lifecycle = 'active';
      state.snapshot.termination = undefined;
      if (state.activeDeliveryIds.length > 0 && state.snapshot.loop.state === 'queued') {
        state.snapshot.loop = {
          ...state.snapshot.loop,
          state: 'running',
          phase: 'waiting-provider',
          enteredAt: at
        };
      }
    });
  }

  release(identity: LifecycleIdentity): AgentSessionSnapshot | undefined {
    return this.change(identity, (state, at) => {
      if (state.snapshot.lifecycle === 'released') return;
      state.snapshot.lifecycle = 'released';
      state.snapshot.connection = 'inactive';
      state.snapshot.loop = {
        state: state.activeDeliveryIds.length > 0 ? 'queued' : 'idle',
        pendingTurnCount: state.activeDeliveryIds.length,
        enteredAt: at,
        activeToolCalls: []
      };
    });
  }

  resume(identity: LifecycleIdentity): AgentSessionSnapshot | undefined {
    return this.change(identity, (state, at) => {
      if (state.snapshot.lifecycle === 'resuming') return;
      state.snapshot.lifecycle = 'resuming';
      state.snapshot.connection = 'connecting';
      state.snapshot.loop = { ...state.snapshot.loop, enteredAt: at };
    });
  }

  terminate(
    identity: LifecycleIdentity & { reason: 'completed' | 'stopped' | 'failed' | 'deleted' }
  ): AgentSessionSnapshot | undefined {
    return this.change(identity, (state, at) => {
      if (state.snapshot.lifecycle === 'terminated' && state.snapshot.termination?.reason === identity.reason) return;
      state.activeDeliveryIds = [];
      state.snapshot.lifecycle = 'terminated';
      state.snapshot.connection = 'inactive';
      state.snapshot.loop = { state: 'idle', pendingTurnCount: 0, enteredAt: at, activeToolCalls: [] };
      state.snapshot.termination = { reason: identity.reason, at };
    });
  }

  private change(
    identity: LifecycleIdentity,
    mutate: (state: PersistedAgentSessionState, at: string) => void
  ): AgentSessionSnapshot | undefined {
    const member = this.options.store.getSessionMember(identity.sessionId, identity.memberId);
    if (member?.type !== 'mesh-agent') return undefined;
    const at = this.now();
    const state = persistedState(member.data.agentSessionState, identity, member.updatedAt);
    const before = JSON.stringify(state);
    mutate(state, at);
    if (JSON.stringify(state) === before) return state.snapshot;
    state.snapshot.revision += 1;
    const snapshot = agentSessionSnapshotSchema.parse(state.snapshot);
    this.options.store.updateSessionMemberData(identity.sessionId, identity.memberId, at, (data) => ({
      ...data,
      agentSessionState: { ...state, snapshot }
    }));
    this.options.bus.publish(
      makeEvent(identity.sessionId, 'agent.session.changed', { memberId: identity.memberId, session: snapshot }, { at })
    );
    return snapshot;
  }
}
