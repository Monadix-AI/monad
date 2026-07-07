'use client';

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
  railObservation: ChatRoomRailObservation | null;
  followExternalAgentSession: (
    projectId: string,
    sessionId: string,
    turnId?: string,
    deliveryId?: NativeAgentDeliveryId
  ) => void;
  observeProjectAgent: (projectId: string, agent: { agentId: string; agentName: string }) => void;
  closeRailObservation: () => void;
}

export const useChatRoomExperienceStore = create<ChatRoomExperienceState>((set) => ({
  railObservation: null,
  followExternalAgentSession: (projectId, sessionId, turnId, deliveryId) =>
    set({
      railObservation: {
        projectId,
        externalAgentSessionId: sessionId,
        ...(turnId ? { turnId } : {}),
        ...(deliveryId ? { deliveryId } : {})
      }
    }),
  observeProjectAgent: (projectId, agent) =>
    set({ railObservation: { projectId, agentId: agent.agentId, agentName: agent.agentName } }),
  closeRailObservation: () => set({ railObservation: null })
}));
