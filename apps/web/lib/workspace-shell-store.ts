'use client';

import type { SessionId } from '@monad/protocol';

import { create } from 'zustand';

type WorkspaceSurface = 'workspace' | 'monadChat';

export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'monad:sidebarCollapsed';
const PINNED_PROJECTS_STORAGE_KEY = 'monad:pinnedProjects';

function sidebarStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readStoredSidebarCollapsed(): boolean {
  return sidebarStorage()?.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
}

export function writeStoredSidebarCollapsed(collapsed: boolean): void {
  try {
    sidebarStorage()?.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // Local UI preference only; ignore private-mode/quota failures.
  }
}

function readStoredPinnedProjectIds(): string[] {
  const raw = sidebarStorage()?.getItem(PINNED_PROJECTS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === 'string' && value.length > 0);
  } catch {
    return [];
  }
}

function writeStoredPinnedProjectIds(projectIds: readonly string[]): void {
  try {
    sidebarStorage()?.setItem(PINNED_PROJECTS_STORAGE_KEY, JSON.stringify([...projectIds]));
  } catch {
    // Local UI preference only; ignore private-mode/quota failures.
  }
}

export interface WorkspaceShellState {
  surface: WorkspaceSurface;
  lastMonadSessionId: SessionId | null;
  activeProjectId: string | null;
  sidebarCollapsed: boolean;
  sidebarAutoReveal: boolean;
  pinnedProjectIds: string[];
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
  toggleProjectPinned: (projectId: string) => void;
  setNewProjectOpen: (open: boolean) => void;
  toggleSessionInspector: () => void;
}

export const useWorkspaceShellStore = create<WorkspaceShellState>()((set) => ({
  surface: 'workspace',
  lastMonadSessionId: null,
  activeProjectId: null,
  sidebarCollapsed: readStoredSidebarCollapsed(),
  sidebarAutoReveal: false,
  pinnedProjectIds: readStoredPinnedProjectIds(),
  newProjectOpen: false,
  sessionInspectorOpen: false,
  setSurface: (surface) => set({ surface }),
  rememberMonadSession: (sessionId) => set({ lastMonadSessionId: sessionId }),
  openWorkspace: () => set({ surface: 'workspace', activeProjectId: null }),
  openMonadChat: () => set({ surface: 'monadChat' }),
  openProject: (projectId) => set({ surface: 'workspace', activeProjectId: projectId }),
  setSidebarCollapsed: (collapsed) => {
    writeStoredSidebarCollapsed(collapsed);
    set({ sidebarCollapsed: collapsed, sidebarAutoReveal: false });
  },
  toggleSidebarCollapsed: () =>
    set((state) => {
      const sidebarCollapsed = !state.sidebarCollapsed;
      writeStoredSidebarCollapsed(sidebarCollapsed);
      return { sidebarCollapsed, sidebarAutoReveal: false };
    }),
  revealSidebar: () => {
    writeStoredSidebarCollapsed(false);
    set({ sidebarCollapsed: false, sidebarAutoReveal: false });
  },
  autoRevealSidebar: () => set({ sidebarCollapsed: false, sidebarAutoReveal: true }),
  collapseSidebar: () => {
    writeStoredSidebarCollapsed(true);
    set({ sidebarCollapsed: true, sidebarAutoReveal: false });
  },
  toggleProjectPinned: (projectId) =>
    set((state) => {
      const pinned = new Set(state.pinnedProjectIds);
      if (pinned.has(projectId)) pinned.delete(projectId);
      else pinned.add(projectId);
      const pinnedProjectIds = [...pinned];
      writeStoredPinnedProjectIds(pinnedProjectIds);
      return { pinnedProjectIds };
    }),
  setNewProjectOpen: (open) => set({ newProjectOpen: open }),
  toggleSessionInspector: () => set((state) => ({ sessionInspectorOpen: !state.sessionInspectorOpen }))
}));
