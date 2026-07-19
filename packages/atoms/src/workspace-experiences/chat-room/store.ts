import type { MessageAttachmentRef, NativeAgentDeliveryId } from '@monad/protocol';

import { create } from 'zustand';

export interface ChatRoomRailObservation {
  projectId: string;
  agentId?: string;
  agentName?: string;
  meshSessionId?: string;
  deliveryId?: NativeAgentDeliveryId;
  turnId?: string;
}

export interface ChatRoomFilePreview {
  attachment: MessageAttachmentRef;
  line?: number;
}

interface ChatRoomExperienceState {
  filePreviewBySession: Record<string, ChatRoomFilePreview>;
  railObservationBySession: Record<string, ChatRoomRailObservation>;
  followMeshSession: (
    uiKey: string,
    projectId: string,
    sessionId: string,
    turnId?: string,
    deliveryId?: NativeAgentDeliveryId
  ) => void;
  observeProjectAgent: (uiKey: string, projectId: string, agent: { agentId: string; agentName: string }) => void;
  openFilePreview: (uiKey: string, preview: ChatRoomFilePreview) => void;
  closeFilePreview: (uiKey: string) => void;
  closeRailObservation: (uiKey: string) => void;
  removeSessionUiState: (uiKey: string) => void;
}

export const useChatRoomExperienceStore = create<ChatRoomExperienceState>((set) => ({
  filePreviewBySession: {},
  railObservationBySession: {},
  followMeshSession: (uiKey, projectId, sessionId, turnId, deliveryId) =>
    set((state) => {
      const filePreviews = { ...state.filePreviewBySession };
      delete filePreviews[uiKey];
      return {
        filePreviewBySession: filePreviews,
        railObservationBySession: {
          ...state.railObservationBySession,
          [uiKey]: {
            projectId,
            meshSessionId: sessionId,
            ...(turnId ? { turnId } : {}),
            ...(deliveryId ? { deliveryId } : {})
          }
        }
      };
    }),
  observeProjectAgent: (uiKey, projectId, agent) =>
    set((state) => {
      const filePreviews = { ...state.filePreviewBySession };
      delete filePreviews[uiKey];
      return {
        filePreviewBySession: filePreviews,
        railObservationBySession: {
          ...state.railObservationBySession,
          [uiKey]: { projectId, agentId: agent.agentId, agentName: agent.agentName }
        }
      };
    }),
  openFilePreview: (uiKey, preview) =>
    set((state) => {
      const observations = { ...state.railObservationBySession };
      delete observations[uiKey];
      return {
        filePreviewBySession: { ...state.filePreviewBySession, [uiKey]: preview },
        railObservationBySession: observations
      };
    }),
  closeFilePreview: (uiKey) =>
    set((state) => {
      const next = { ...state.filePreviewBySession };
      delete next[uiKey];
      return { filePreviewBySession: next };
    }),
  closeRailObservation: (uiKey) =>
    set((state) => {
      const next = { ...state.railObservationBySession };
      delete next[uiKey];
      return { railObservationBySession: next };
    }),
  removeSessionUiState: (uiKey) =>
    set((state) => {
      const observations = { ...state.railObservationBySession };
      const filePreviews = { ...state.filePreviewBySession };
      delete observations[uiKey];
      delete filePreviews[uiKey];
      return { filePreviewBySession: filePreviews, railObservationBySession: observations };
    })
}));

export function projectSessionUiKey(projectId: string, sessionId: string | null): string {
  return `project:${projectId}:session:${sessionId ?? 'none'}`;
}

export function removeChatRoomSessionUiState(uiKey: string): void {
  useChatRoomExperienceStore.getState().removeSessionUiState(uiKey);
}
