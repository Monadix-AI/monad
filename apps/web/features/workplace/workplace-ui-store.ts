'use client';

import { create } from 'zustand';

interface ProjectSettingsState {
  projectId: string;
  intent?: 'connect-agent' | 'spawn-agent';
}

interface ProjectMemberSettingsState {
  projectId: string;
  memberId: string | null;
}

export const SHOW_DEV_SYSTEM_MESSAGES_IN_STREAM_KEY = 'monad.workplace.showDevSystemMessagesInStream';

export const DEV_SYSTEM_MESSAGES_IN_STREAM_ENABLED = process.env.NODE_ENV !== 'production';

function readShowDevSystemMessagesInStream(): boolean {
  if (!DEV_SYSTEM_MESSAGES_IN_STREAM_ENABLED || typeof window === 'undefined') return false;
  return window.localStorage.getItem(SHOW_DEV_SYSTEM_MESSAGES_IN_STREAM_KEY) === 'true';
}

interface WorkplaceUiState {
  projectSettings: ProjectSettingsState | null;
  projectMemberSettings: ProjectMemberSettingsState | null;
  showDevSystemMessagesInStream: boolean;
  openProjectSettings: (projectId: string, intent?: ProjectSettingsState['intent']) => void;
  closeProjectSettings: () => void;
  openProjectMemberSettings: (projectId: string, memberId: string) => void;
  closeProjectMemberSettings: () => void;
  setShowDevSystemMessagesInStream: (show: boolean) => void;
}

export const useWorkplaceUiStore = create<WorkplaceUiState>((set) => ({
  projectSettings: null,
  projectMemberSettings: null,
  showDevSystemMessagesInStream: readShowDevSystemMessagesInStream(),
  openProjectSettings: (projectId, intent) => set({ projectSettings: { projectId, ...(intent ? { intent } : {}) } }),
  closeProjectSettings: () => set({ projectSettings: null }),
  openProjectMemberSettings: (projectId, memberId) => set({ projectMemberSettings: { projectId, memberId } }),
  closeProjectMemberSettings: () => set({ projectMemberSettings: null }),
  setShowDevSystemMessagesInStream: (show) => {
    if (!DEV_SYSTEM_MESSAGES_IN_STREAM_ENABLED) return;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SHOW_DEV_SYSTEM_MESSAGES_IN_STREAM_KEY, String(show));
    }
    set({ showDevSystemMessagesInStream: show });
  }
}));
