'use client';

import type { SessionId } from '@monad/protocol';

import { create } from 'zustand';

type WorkspaceSurface = 'workspace' | 'monadChat';

export interface WorkspaceShellState {
  surface: WorkspaceSurface;
  lastMonadSessionId: SessionId | null;
  activeProjectId: string | null;
  sidebarCollapsed: boolean;
  sidebarAutoReveal: boolean;
  newProjectOpen: boolean;
  sessionInspectorOpen: boolean;
  setSurface: (surface: WorkspaceSurface) => void;
  rememberMonadSession: (sessionId: SessionId | null) => void;
  openWorkspace: () => void;
  openMonadChat: () => void;
  openProject: (projectId: string) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebarCollapsed: () => void;
  revealSidebar: () => void;
  autoRevealSidebar: () => void;
  collapseSidebar: () => void;
  setNewProjectOpen: (open: boolean) => void;
  toggleSessionInspector: () => void;
}

export const useWorkspaceShellStore = create<WorkspaceShellState>()((set) => ({
  surface: 'workspace',
  lastMonadSessionId: null,
  activeProjectId: null,
  sidebarCollapsed: false,
  sidebarAutoReveal: false,
  newProjectOpen: false,
  sessionInspectorOpen: false,
  setSurface: (surface) => set({ surface }),
  rememberMonadSession: (sessionId) => set({ lastMonadSessionId: sessionId }),
  openWorkspace: () => set({ surface: 'workspace', activeProjectId: null }),
  openMonadChat: () => set({ surface: 'monadChat' }),
  openProject: (projectId) => set({ surface: 'workspace', activeProjectId: projectId }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed, sidebarAutoReveal: false }),
  toggleSidebarCollapsed: () =>
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed, sidebarAutoReveal: false })),
  revealSidebar: () => set({ sidebarCollapsed: false, sidebarAutoReveal: false }),
  autoRevealSidebar: () => set({ sidebarCollapsed: false, sidebarAutoReveal: true }),
  collapseSidebar: () => set({ sidebarCollapsed: true, sidebarAutoReveal: false }),
  setNewProjectOpen: (open) => set({ newProjectOpen: open }),
  toggleSessionInspector: () => set((state) => ({ sessionInspectorOpen: !state.sessionInspectorOpen }))
}));
