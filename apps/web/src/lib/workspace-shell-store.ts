'use client';

import type { SessionId } from '@monad/protocol';
import type { StudioSectionId } from '#/features/studio/sections';

import { create } from 'zustand';

import { isWorkspacePath } from '#/features/shell/routing/paths';
import { isStudioSectionId } from '#/features/studio/sections';

type WorkspaceSurface = 'workspace' | 'monadChat';

type ActiveProjectSessionState = {
  activeSessionId: SessionId | null;
  projectId: string;
  switchSession: (id: SessionId) => void;
};

type PendingProjectSessionState = {
  projectId: string;
  sessionId: SessionId;
};

export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'monad:sidebarCollapsed';
export const LAST_STUDIO_SECTION_STORAGE_KEY = 'monad:lastStudioSection';
export const LAST_WORKSPACE_PATH_STORAGE_KEY = 'monad:lastWorkspacePath';
const PINNED_PROJECTS_STORAGE_KEY = 'monad:pinnedProjects';

function shellStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readStoredSidebarCollapsed(): boolean {
  return shellStorage()?.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
}

export function writeStoredSidebarCollapsed(collapsed: boolean): void {
  try {
    shellStorage()?.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // Local UI preference only; ignore private-mode/quota failures.
  }
}

export function readStoredLastStudioSection(): StudioSectionId {
  const value = shellStorage()?.getItem(LAST_STUDIO_SECTION_STORAGE_KEY);
  return isStudioSectionId(value) ? value : 'runtime';
}

export function writeStoredLastStudioSection(section: StudioSectionId): void {
  try {
    shellStorage()?.setItem(LAST_STUDIO_SECTION_STORAGE_KEY, section);
  } catch {
    // Local UI preference only; ignore private-mode/quota failures.
  }
}

export function readStoredLastWorkspacePath(): string {
  const value = shellStorage()?.getItem(LAST_WORKSPACE_PATH_STORAGE_KEY);
  return value && isWorkspacePath(value) ? value : '/';
}

export function writeStoredLastWorkspacePath(path: string): void {
  if (!isWorkspacePath(path)) return;
  try {
    shellStorage()?.setItem(LAST_WORKSPACE_PATH_STORAGE_KEY, path);
  } catch {
    // Local UI preference only; ignore private-mode/quota failures.
  }
}

function readStoredPinnedProjectIds(): string[] {
  const raw = shellStorage()?.getItem(PINNED_PROJECTS_STORAGE_KEY);
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
    shellStorage()?.setItem(PINNED_PROJECTS_STORAGE_KEY, JSON.stringify([...projectIds]));
  } catch {
    // Local UI preference only; ignore private-mode/quota failures.
  }
}

export interface WorkspaceShellState {
  surface: WorkspaceSurface;
  lastStudioSection: StudioSectionId;
  lastWorkspacePath: string;
  lastMonadSessionId: SessionId | null;
  settingsReturnPathState: string | null;
  activeProjectId: string | null;
  activeProjectSession: ActiveProjectSessionState | null;
  pendingProjectSession: PendingProjectSessionState | null;
  sidebarCollapsed: boolean;
  sidebarAutoReveal: boolean;
  pinnedProjectIds: string[];
  newProjectOpen: boolean;
  rightPanelOpen: boolean;
  setSurface: (surface: WorkspaceSurface) => void;
  rememberStudioSection: (section: StudioSectionId) => void;
  rememberWorkspacePath: (path: string) => void;
  rememberMonadSession: (sessionId: SessionId | null) => void;
  setSettingsReturnPathState: (path: string | null) => void;
  openWorkspace: () => void;
  openMonadChat: () => void;
  openProject: (projectId: string) => void;
  setActiveProjectSession: (state: ActiveProjectSessionState | null) => void;
  setPendingProjectSession: (state: PendingProjectSessionState | null) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebarCollapsed: () => void;
  revealSidebar: () => void;
  autoRevealSidebar: () => void;
  collapseSidebar: () => void;
  toggleProjectPinned: (projectId: string) => void;
  setNewProjectOpen: (open: boolean) => void;
  openRightPanel: () => void;
  closeRightPanel: () => void;
  toggleRightPanel: () => void;
}

export const useWorkspaceShellStore = create<WorkspaceShellState>()((set) => ({
  surface: 'workspace',
  lastStudioSection: readStoredLastStudioSection(),
  lastWorkspacePath: readStoredLastWorkspacePath(),
  lastMonadSessionId: null,
  settingsReturnPathState: null,
  activeProjectId: null,
  activeProjectSession: null,
  pendingProjectSession: null,
  sidebarCollapsed: readStoredSidebarCollapsed(),
  sidebarAutoReveal: false,
  pinnedProjectIds: readStoredPinnedProjectIds(),
  newProjectOpen: false,
  rightPanelOpen: false,
  setSurface: (surface) => set({ surface }),
  rememberStudioSection: (section) => {
    writeStoredLastStudioSection(section);
    set({ lastStudioSection: section });
  },
  rememberWorkspacePath: (path) => {
    if (!isWorkspacePath(path)) return;
    writeStoredLastWorkspacePath(path);
    set({ lastWorkspacePath: path });
  },
  rememberMonadSession: (sessionId) => set({ lastMonadSessionId: sessionId }),
  setSettingsReturnPathState: (path) => set({ settingsReturnPathState: path }),
  openWorkspace: () =>
    set({ surface: 'workspace', activeProjectId: null, activeProjectSession: null, pendingProjectSession: null }),
  openMonadChat: () =>
    set({ surface: 'monadChat', activeProjectId: null, activeProjectSession: null, pendingProjectSession: null }),
  openProject: (projectId) => set({ surface: 'workspace', activeProjectId: projectId }),
  setActiveProjectSession: (state) => set({ activeProjectSession: state }),
  setPendingProjectSession: (state) => set({ pendingProjectSession: state }),
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
  openRightPanel: () => set({ rightPanelOpen: true }),
  closeRightPanel: () => set({ rightPanelOpen: false }),
  toggleRightPanel: () => set((state) => ({ rightPanelOpen: !state.rightPanelOpen }))
}));
