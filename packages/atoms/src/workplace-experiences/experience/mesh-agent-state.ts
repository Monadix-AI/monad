import type {
  EventId,
  MeshAgentLoginRequirement,
  MeshAgentPendingApproval,
  MeshAgentStateEvent,
  MeshAgentStateSession,
  MeshAgentSystemEvent
} from '@monad/protocol';

import { meshAgentLoginRequirementId, meshAgentPendingApprovalSchema, parseEventPayload } from '@monad/protocol';

import { workplaceExperienceT } from '../i18n.ts';

export interface MeshAgentLifecycleNotice {
  id: string;
  agentName: string;
  event: MeshAgentSystemEvent;
  kind: 'connection-required' | 'exited' | 'failed' | 'idle-resumed' | 'idle-suspended' | 'resume-failed' | 'stopped';
  meshSessionId?: string;
  observedAt: string;
  text: string;
  tone: 'error' | 'info' | 'warning';
}

export interface MeshAgentRuntimeStatusView {
  kind: 'active' | 'idle' | 'stale' | 'starting' | 'suspended' | 'terminal';
  label: string;
  tone: 'error' | 'idle' | 'working';
}

export interface MeshAgentExperienceInput {
  sessions: Readonly<Record<string, MeshAgentStateSession>>;
  loginRequirements: Readonly<Record<string, MeshAgentLoginRequirement>>;
  approvals: Readonly<Record<string, MeshAgentPendingApproval>>;
  events: readonly MeshAgentStateEvent[];
  snapshotReceived: boolean;
  stale: boolean;
}

export interface MeshAgentExperienceState {
  sessions: Map<string, MeshAgentStateSession>;
  loginRequirements: Map<string, MeshAgentLoginRequirement>;
  approvals: Map<string, MeshAgentPendingApproval>;
  events: MeshAgentStateEvent[];
  acceptedEventIds: Set<EventId>;
  activeMeshSessionIds: Set<string>;
  connectedMeshSessionIds: Set<string>;
  snapshotReceived: boolean;
  stale: boolean;
}

export function foldMeshAgentExperienceState(input: MeshAgentExperienceInput): MeshAgentExperienceState {
  const state: MeshAgentExperienceState = {
    sessions: new Map(Object.entries(input.sessions)),
    loginRequirements: new Map(Object.entries(input.loginRequirements)),
    approvals: new Map(Object.entries(input.approvals)),
    events: [],
    acceptedEventIds: new Set(),
    activeMeshSessionIds: new Set(),
    connectedMeshSessionIds: new Set(),
    snapshotReceived: input.snapshotReceived,
    stale: input.stale
  };
  for (const event of input.events) applyMeshAgentExperienceEvent(state, event);
  return state;
}

export function applyMeshAgentExperienceEvent(state: MeshAgentExperienceState, event: MeshAgentStateEvent): void {
  if (state.acceptedEventIds.has(event.id)) return;
  state.acceptedEventIds.add(event.id);
  state.events.push(event);

  switch (event.type) {
    case 'mesh.login_required': {
      const payload = parseEventPayload('mesh.login_required', event.payload);
      const authAgentName = payload.authAgentName ?? payload.agentName;
      const id = meshAgentLoginRequirementId(payload.agentName, authAgentName);
      state.loginRequirements.set(id, {
        id,
        observedAt: event.at,
        agentName: payload.agentName,
        authAgentName,
        provider: payload.provider,
        ...(payload.meshSessionId ? { meshSessionId: payload.meshSessionId } : {}),
        reason: payload.reason
      });
      return;
    }
    case 'mesh.login_resolved': {
      const payload = parseEventPayload('mesh.login_resolved', event.payload);
      state.loginRequirements.delete(meshAgentLoginRequirementId(payload.agentName, payload.authAgentName));
      return;
    }
    case 'mesh.approval_requested': {
      const payload = parseEventPayload('mesh.approval_requested', event.payload);
      state.approvals.set(
        payload.requestId,
        meshAgentPendingApprovalSchema.parse({
          requestId: payload.requestId,
          meshSessionId: payload.meshSessionId,
          provider: payload.provider,
          text: payload.text,
          ...(payload.data === undefined ? {} : { data: payload.data }),
          requestedAt: event.at
        })
      );
      return;
    }
    case 'mesh.approval_resolved': {
      const payload = parseEventPayload('mesh.approval_resolved', event.payload);
      state.approvals.delete(payload.requestId);
      return;
    }
    case 'mesh.turn_started': {
      const payload = parseEventPayload('mesh.turn_started', event.payload);
      state.activeMeshSessionIds.add(payload.meshSessionId);
      return;
    }
    case 'mesh.turn_settled': {
      const payload = parseEventPayload('mesh.turn_settled', event.payload);
      state.activeMeshSessionIds.delete(payload.meshSessionId);
      return;
    }
    case 'mesh.session.connection.opened': {
      const payload = parseEventPayload('mesh.session.connection.opened', event.payload);
      state.connectedMeshSessionIds.add(payload.meshSessionId);
      return;
    }
    case 'mesh.session.connection.closed': {
      const payload = parseEventPayload('mesh.session.connection.closed', event.payload);
      state.connectedMeshSessionIds.delete(payload.meshSessionId);
      return;
    }
    case 'mesh.exited': {
      const payload = parseEventPayload('mesh.exited', event.payload);
      state.activeMeshSessionIds.delete(payload.meshSessionId);
      state.connectedMeshSessionIds.delete(payload.meshSessionId);
      return;
    }
  }
}

function sessionAgentName(state: MeshAgentExperienceState, meshSessionId: string): string {
  return state.sessions.get(meshSessionId)?.agentName ?? meshSessionId;
}

export function meshAgentLifecycleNotices(state: MeshAgentExperienceState): MeshAgentLifecycleNotice[] {
  const t = workplaceExperienceT();
  // `connection_required` is the durable provider-level failure. Once the auth probe confirms that
  // the same runtime needs a login, `login_required` becomes the actionable chat card and the generic
  // reconnect notice would only duplicate it (and can expose an internal ProjectMember id as text).
  // Remember live login events as well as the current snapshot requirement so resolving the card does
  // not make the older reconnect notice reappear during the same projection lifetime.
  const loginRequiredMeshSessionIds = new Set(
    [...state.loginRequirements.values()].flatMap((requirement) =>
      requirement.meshSessionId ? [requirement.meshSessionId] : []
    )
  );
  const pendingLoginAgentNames = new Set(
    [...state.loginRequirements.values()].map((requirement) => requirement.agentName)
  );
  for (const event of state.events) {
    if (event.type !== 'mesh.login_required') continue;
    const payload = parseEventPayload('mesh.login_required', event.payload);
    if (payload.meshSessionId) loginRequiredMeshSessionIds.add(payload.meshSessionId);
  }
  return state.events.flatMap((event): MeshAgentLifecycleNotice[] => {
    if (event.type === 'mesh.idle_suspended') {
      const payload = parseEventPayload('mesh.idle_suspended', event.payload);
      return [
        {
          id: `mesh-agent-idle-suspended:${payload.agentId}:${event.id}`,
          agentName: payload.agentName,
          event: payload,
          kind: 'idle-suspended',
          meshSessionId: payload.payload.meshSessionId,
          observedAt: event.at,
          text: t('web.meshAgent.lifecycle.idleSuspended'),
          tone: 'info'
        }
      ];
    }
    if (event.type === 'mesh.idle_resumed') {
      const payload = parseEventPayload('mesh.idle_resumed', event.payload);
      return [
        {
          id: `mesh-agent-idle-resumed:${payload.agentId}:${event.id}`,
          agentName: payload.agentName,
          event: payload,
          kind: 'idle-resumed',
          meshSessionId: payload.payload.meshSessionId,
          observedAt: event.at,
          text: t('web.meshAgent.lifecycle.idleResumed'),
          tone: 'info'
        }
      ];
    }
    if (event.type === 'mesh.resume_failed') {
      const payload = parseEventPayload('mesh.resume_failed', event.payload);
      return [
        {
          id: `mesh-agent-resume-failed:${payload.agentName}:${event.id}`,
          agentName: payload.agentName,
          event: {
            agentId: payload.agentName,
            agentName: payload.agentName,
            type: 'resume_failed',
            payload: { provider: payload.provider, providerSessionRef: payload.providerSessionRef }
          },
          kind: 'resume-failed',
          observedAt: event.at,
          text: t('web.meshAgent.lifecycle.resumeFailed', {
            provider: payload.provider,
            ref: payload.providerSessionRef
          }),
          tone: 'warning'
        }
      ];
    }
    if (event.type === 'mesh.connection_required') {
      const payload = parseEventPayload('mesh.connection_required', event.payload);
      if (
        payload.meshSessionId
          ? loginRequiredMeshSessionIds.has(payload.meshSessionId)
          : pendingLoginAgentNames.has(payload.agentName)
      )
        return [];
      return [
        {
          id: `mesh-agent-connection-required:${payload.agentName}:${event.id}`,
          agentName: payload.agentName,
          event: {
            agentId: payload.agentName,
            agentName: payload.agentName,
            type: 'connection_required',
            payload: { ...(payload.meshSessionId ? { meshSessionId: payload.meshSessionId } : {}) }
          },
          kind: 'connection-required',
          ...(payload.meshSessionId ? { meshSessionId: payload.meshSessionId } : {}),
          observedAt: event.at,
          text: t('web.meshAgent.lifecycle.connectionRequired', { agentName: payload.agentName }),
          tone: 'error'
        }
      ];
    }
    if (event.type === 'mesh.exited') {
      const payload = parseEventPayload('mesh.exited', event.payload);
      const session = state.sessions.get(payload.meshSessionId);
      if (
        payload.state === 'failed' &&
        session?.lifecycle.state === 'terminal' &&
        session.lifecycle.termination.kind === 'failed' &&
        session.lifecycle.termination.error
      )
        return [];
      const agentName = sessionAgentName(state, payload.meshSessionId);
      const exitCode = payload.exitCode === null ? '' : ` (${payload.exitCode})`;
      const key =
        payload.state === 'failed'
          ? 'web.meshAgent.lifecycle.failed'
          : payload.state === 'stopped'
            ? 'web.meshAgent.lifecycle.stopped'
            : 'web.meshAgent.lifecycle.exited';
      return [
        {
          id: `mesh-agent-${payload.state}:${agentName}:${event.id}`,
          agentName,
          event: {
            agentId: agentName,
            agentName,
            type: payload.state,
            payload: { meshSessionId: payload.meshSessionId, exitCode: payload.exitCode }
          },
          kind: payload.state,
          meshSessionId: payload.meshSessionId,
          observedAt: event.at,
          text: payload.state === 'stopped' ? t(key, { agentName }) : t(key, { agentName, exitCode }),
          tone: payload.state === 'failed' ? 'error' : 'info'
        }
      ];
    }
    return [];
  });
}

export function meshAgentRuntimeStatus(
  state: Pick<MeshAgentExperienceState, 'stale'>,
  session: MeshAgentStateSession
): MeshAgentRuntimeStatusView {
  const t = workplaceExperienceT();
  if (state.stale) return { kind: 'stale', label: t('web.meshAgent.status.stale'), tone: 'working' };
  if (session.lifecycle.state === 'terminal') {
    return {
      kind: 'terminal',
      label: t('web.meshAgent.status.terminal'),
      tone: session.lifecycle.termination.kind === 'failed' ? 'error' : 'idle'
    };
  }
  if (session.lifecycle.state === 'starting') {
    return { kind: 'starting', label: t('web.meshAgent.status.starting'), tone: 'working' };
  }
  if (session.activity.state === 'suspended') {
    return { kind: 'suspended', label: t('web.meshAgent.status.suspended'), tone: 'idle' };
  }
  if (session.activity.state === 'idle') {
    return { kind: 'idle', label: t('web.meshAgent.status.idle'), tone: 'idle' };
  }
  return { kind: 'active', label: t('web.meshAgent.status.active'), tone: 'working' };
}
