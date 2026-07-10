'use client';

import { create } from 'zustand';

interface ProjectMemberSettingsState {
  projectId: string;
  memberId: string | null;
}

interface WorkplaceUiState {
  sessionSettings: { projectId: string } | null;
  projectMemberSettings: ProjectMemberSettingsState | null;
  openSessionSettings: (projectId: string) => void;
  closeSessionSettings: () => void;
  openProjectMemberSettings: (projectId: string, memberId: string) => void;
  closeProjectMemberSettings: () => void;
}

export const useWorkplaceUiStore = create<WorkplaceUiState>((set) => ({
  sessionSettings: null,
  projectMemberSettings: null,
  openSessionSettings: (projectId) => set({ sessionSettings: { projectId } }),
  closeSessionSettings: () => set({ sessionSettings: null }),
  openProjectMemberSettings: (projectId, memberId) => set({ projectMemberSettings: { projectId, memberId } }),
  closeProjectMemberSettings: () => set({ projectMemberSettings: null })
}));
