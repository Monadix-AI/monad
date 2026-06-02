import type {
  EventId,
  MeshAgentLoginRequirement,
  MeshAgentPendingApproval,
  MeshAgentStateEvent,
  MeshAgentStateFrame,
  MeshAgentStateSession,
  SessionId
} from '@monad/protocol';

import { meshAgentLoginRequirementId, meshAgentPendingApprovalSchema, parseEventPayload } from '@monad/protocol';

import { clientOf } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

export const MAX_MESH_AGENT_STATE_EVENTS = 512;

// Login/approval transitions are folded into the authoritative maps below; keeping their events in the
// bounded tail too would let eviction of a request (or its resolution) drift the derived state — a live
// requirement vanishing, or a resolved one reviving. The tail retains only the events the experience
// still replays for lifecycle notices and activity/connection sets.
function materializeLoginApproval(draft: MeshAgentStateStreamState, event: MeshAgentStateEvent): boolean {
  switch (event.type) {
    case 'mesh.login_required': {
      const payload = parseEventPayload('mesh.login_required', event.payload);
      const authAgentName = payload.authAgentName ?? payload.agentName;
      const id = meshAgentLoginRequirementId(payload.agentName, authAgentName);
      draft.loginRequirements[id] = {
        id,
        observedAt: event.at,
        agentName: payload.agentName,
        authAgentName,
        provider: payload.provider,
        ...(payload.meshSessionId ? { meshSessionId: payload.meshSessionId } : {}),
        reason: payload.reason
      };
      return true;
    }
    case 'mesh.login_resolved': {
      const payload = parseEventPayload('mesh.login_resolved', event.payload);
      delete draft.loginRequirements[meshAgentLoginRequirementId(payload.agentName, payload.authAgentName)];
      return true;
    }
    case 'mesh.approval_requested': {
      const payload = parseEventPayload('mesh.approval_requested', event.payload);
      draft.approvals[payload.requestId] = meshAgentPendingApprovalSchema.parse({
        requestId: payload.requestId,
        meshSessionId: payload.meshSessionId,
        provider: payload.provider,
        text: payload.text,
        ...(payload.data === undefined ? {} : { data: payload.data }),
        requestedAt: event.at
      });
      return true;
    }
    case 'mesh.approval_resolved': {
      const payload = parseEventPayload('mesh.approval_resolved', event.payload);
      delete draft.approvals[payload.requestId];
      return true;
    }
    default:
      return false;
  }
}

export interface MeshAgentStateStreamState {
  sessions: Record<string, MeshAgentStateSession>;
  loginRequirements: Record<string, MeshAgentLoginRequirement>;
  approvals: Record<string, MeshAgentPendingApproval>;
  events: MeshAgentStateEvent[];
  acceptedEventIds: EventId[];
  lastEventId?: EventId;
  snapshotReceived: boolean;
  stale: boolean;
  streamError?: { kind: 'fatal' | 'transient'; status?: number };
}

function byKey<T>(values: T[], keyOf: (value: T) => string): Record<string, T> {
  return Object.fromEntries(values.map((value) => [keyOf(value), value]));
}

export function initialMeshAgentStateStreamState(): MeshAgentStateStreamState {
  return {
    sessions: {},
    loginRequirements: {},
    approvals: {},
    events: [],
    acceptedEventIds: [],
    snapshotReceived: false,
    stale: true
  };
}

export function applyMeshAgentStateFrame(draft: MeshAgentStateStreamState, frame: MeshAgentStateFrame): void {
  draft.streamError = undefined;
  if (frame.kind === 'snapshot') {
    draft.sessions = byKey(frame.sessions, (session) => session.id);
    draft.loginRequirements = byKey(frame.loginRequirements, (requirement) => requirement.id);
    draft.approvals = byKey(frame.approvals, (approval) => approval.requestId);
    draft.events = [...(frame.lifecycleEvents ?? [])];
    draft.acceptedEventIds = (frame.lifecycleEvents ?? []).map((event) => event.id);
    draft.lastEventId = frame.cursor;
    draft.snapshotReceived = true;
    draft.stale = false;
    return;
  }
  if (frame.kind === 'unavailable') {
    draft.stale = true;
    return;
  }
  if (draft.acceptedEventIds.includes(frame.event.id)) return;
  draft.acceptedEventIds.push(frame.event.id);
  if (draft.acceptedEventIds.length > MAX_MESH_AGENT_STATE_EVENTS) {
    draft.acceptedEventIds.splice(0, draft.acceptedEventIds.length - MAX_MESH_AGENT_STATE_EVENTS);
  }
  // Fold login/approval into the authoritative maps; only non-materialized events join the bounded tail
  // so evicting the tail can never drop or revive a login requirement or a pending approval.
  if (!materializeLoginApproval(draft, frame.event)) {
    draft.events.push(frame.event);
    if (draft.events.length > MAX_MESH_AGENT_STATE_EVENTS) {
      draft.events.splice(0, draft.events.length - MAX_MESH_AGENT_STATE_EVENTS);
    }
  }
  draft.lastEventId = frame.event.id;
  draft.stale = false;
}

const streamMeshAgentStateApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    streamMeshAgentState: builder.query<MeshAgentStateStreamState, SessionId>({
      keepUnusedDataFor: 0,
      queryFn: () => ({ data: initialMeshAgentStateStreamState() }),
      async onCacheEntryAdded(sessionId, { cacheDataLoaded, cacheEntryRemoved, updateCachedData, extra }) {
        let dispose: (() => void) | undefined;
        try {
          await cacheDataLoaded;
          dispose = clientOf({ extra }).streamMeshAgentState(
            sessionId,
            (frame) => updateCachedData((draft) => applyMeshAgentStateFrame(draft, frame)),
            {
              onError: (error) =>
                updateCachedData((draft) => {
                  draft.stale = true;
                  draft.streamError = { kind: error.kind, status: error.status };
                })
            }
          );
        } catch {}
        await cacheEntryRemoved;
        dispose?.();
      }
    })
  })
});

export const { useStreamMeshAgentStateQuery } = streamMeshAgentStateApi;
