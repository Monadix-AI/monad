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

interface WorkplaceUiState {
  projectSettings: ProjectSettingsState | null;
  projectMemberSettings: ProjectMemberSettingsState | null;
  openProjectSettings: (projectId: string, intent?: ProjectSettingsState['intent']) => void;
  closeProjectSettings: () => void;
  openProjectMemberSettings: (projectId: string, memberId: string) => void;
  closeProjectMemberSettings: () => void;
}

export const useWorkplaceUiStore = create<WorkplaceUiState>((set) => ({
  projectSettings: null,
  projectMemberSettings: null,
  openProjectSettings: (projectId, intent) => set({ projectSettings: { projectId, ...(intent ? { intent } : {}) } }),
  closeProjectSettings: () => set({ projectSettings: null }),
  openProjectMemberSettings: (projectId, memberId) => set({ projectMemberSettings: { projectId, memberId } }),
  closeProjectMemberSettings: () => set({ projectMemberSettings: null })
}));
