import type { NativeAgentDeliveryId } from '@monad/protocol';

import { create } from 'zustand';

export interface ChatRoomRailObservation {
  projectId: string;
  agentId?: string;
  agentName?: string;
  externalAgentSessionId?: string;
  deliveryId?: NativeAgentDeliveryId;
  turnId?: string;
}

interface ChatRoomExperienceState {
  railObservationBySession: Record<string, ChatRoomRailObservation>;
  followExternalAgentSession: (
    uiKey: string,
    projectId: string,
    sessionId: string,
    turnId?: string,
    deliveryId?: NativeAgentDeliveryId
  ) => void;
  observeProjectAgent: (uiKey: string, projectId: string, agent: { agentId: string; agentName: string }) => void;
  closeRailObservation: (uiKey: string) => void;
  removeSessionUiState: (uiKey: string) => void;
}

export const useChatRoomExperienceStore = create<ChatRoomExperienceState>((set) => ({
  railObservationBySession: {},
  followExternalAgentSession: (uiKey, projectId, sessionId, turnId, deliveryId) =>
    set((state) => ({
      railObservationBySession: {
        ...state.railObservationBySession,
        [uiKey]: {
          projectId,
          externalAgentSessionId: sessionId,
          ...(turnId ? { turnId } : {}),
          ...(deliveryId ? { deliveryId } : {})
        }
      }
    })),
  observeProjectAgent: (uiKey, projectId, agent) =>
    set((state) => ({
      railObservationBySession: {
        ...state.railObservationBySession,
        [uiKey]: { projectId, agentId: agent.agentId, agentName: agent.agentName }
      }
    })),
  closeRailObservation: (uiKey) =>
    set((state) => {
      const next = { ...state.railObservationBySession };
      delete next[uiKey];
      return { railObservationBySession: next };
    }),
  removeSessionUiState: (uiKey) =>
    set((state) => {
      const next = { ...state.railObservationBySession };
      delete next[uiKey];
      return { railObservationBySession: next };
    })
}));

export function projectSessionUiKey(projectId: string, sessionId: string | null): string {
  return `project:${projectId}:session:${sessionId ?? 'none'}`;
}

export function removeChatRoomSessionUiState(uiKey: string): void {
  useChatRoomExperienceStore.getState().removeSessionUiState(uiKey);
}
