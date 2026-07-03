'use client';

import { create } from 'zustand';

interface RailObservation {
  projectId: string;
  agentId?: string;
  agentName?: string;
  nativeCliSessionId?: string;
  turnId?: string;
}

interface ProjectSettingsState {
  projectId: string;
  intent?: 'connect-agent' | 'spawn-agent';
}

interface ProjectMemberSettingsState {
  projectId: string;
  memberId: string | null;
}

interface NativeCliAuthSessionState {
  id: string;
  controlToken: string;
  agentName: string;
}

export const SHOW_DEV_SYSTEM_MESSAGES_IN_STREAM_KEY = 'monad.workplace.showDevSystemMessagesInStream';

export const DEV_SYSTEM_MESSAGES_IN_STREAM_ENABLED = process.env.NODE_ENV !== 'production';

function readShowDevSystemMessagesInStream(): boolean {
  if (!DEV_SYSTEM_MESSAGES_IN_STREAM_ENABLED || typeof window === 'undefined') return false;
  return window.localStorage.getItem(SHOW_DEV_SYSTEM_MESSAGES_IN_STREAM_KEY) === 'true';
}

interface WorkplaceUiState {
  railObservation: RailObservation | null;
  projectSettings: ProjectSettingsState | null;
  projectMemberSettings: ProjectMemberSettingsState | null;
  nativeCliAuthSession: NativeCliAuthSessionState | null;
  startingNativeCliAuthAgent: string | null;
  showDevSystemMessagesInStream: boolean;
  followNativeCliSession: (projectId: string, sessionId: string, turnId?: string) => void;
  observeProjectAgent: (projectId: string, agent: { agentId: string; agentName: string }) => void;
  closeRailObservation: () => void;
  openProjectSettings: (projectId: string, intent?: ProjectSettingsState['intent']) => void;
  closeProjectSettings: () => void;
  openProjectMemberSettings: (projectId: string, memberId: string) => void;
  closeProjectMemberSettings: () => void;
  setNativeCliAuthSession: (session: NativeCliAuthSessionState | null) => void;
  clearNativeCliAuthSession: () => void;
  setStartingNativeCliAuthAgent: (agentName: string | null) => void;
  setShowDevSystemMessagesInStream: (show: boolean) => void;
}

export const useWorkplaceUiStore = create<WorkplaceUiState>((set) => ({
  railObservation: null,
  projectSettings: null,
  projectMemberSettings: null,
  nativeCliAuthSession: null,
  startingNativeCliAuthAgent: null,
  showDevSystemMessagesInStream: readShowDevSystemMessagesInStream(),
  followNativeCliSession: (projectId, sessionId, turnId) =>
    set({ railObservation: { projectId, nativeCliSessionId: sessionId, ...(turnId ? { turnId } : {}) } }),
  observeProjectAgent: (projectId, agent) =>
    set({ railObservation: { projectId, agentId: agent.agentId, agentName: agent.agentName } }),
  closeRailObservation: () => set({ railObservation: null }),
  openProjectSettings: (projectId, intent) => set({ projectSettings: { projectId, ...(intent ? { intent } : {}) } }),
  closeProjectSettings: () => set({ projectSettings: null }),
  openProjectMemberSettings: (projectId, memberId) => set({ projectMemberSettings: { projectId, memberId } }),
  closeProjectMemberSettings: () => set({ projectMemberSettings: null }),
  setNativeCliAuthSession: (session) => set({ nativeCliAuthSession: session }),
  clearNativeCliAuthSession: () => set({ nativeCliAuthSession: null }),
  setStartingNativeCliAuthAgent: (agentName) => set({ startingNativeCliAuthAgent: agentName }),
  setShowDevSystemMessagesInStream: (show) => {
    if (!DEV_SYSTEM_MESSAGES_IN_STREAM_ENABLED) return;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SHOW_DEV_SYSTEM_MESSAGES_IN_STREAM_KEY, String(show));
    }
    set({ showDevSystemMessagesInStream: show });
  }
}));
