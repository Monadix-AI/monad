'use client';

import type { SessionId } from '@monad/protocol';
import type { StudioSectionId } from '#/features/studio/sections';

import { create } from 'zustand';

import { isStudioSectionId } from '#/features/studio/sections';

type WorkspaceSurface = 'workspace' | 'monadChat';

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

function isWorkspacePath(value: string | null | undefined): value is string {
  return value === '/' || Boolean(value?.startsWith('/workplace/projects/') || value?.startsWith('/sessions/'));
}

export function readStoredLastWorkspacePath(): string {
  const value = shellStorage()?.getItem(LAST_WORKSPACE_PATH_STORAGE_KEY);
  return isWorkspacePath(value) ? value : '/';
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
  activeProjectId: string | null;
  sidebarCollapsed: boolean;
  sidebarAutoReveal: boolean;
  pinnedProjectIds: string[];
  newProjectOpen: boolean;
  sessionInspectorOpen: boolean;
  setSurface: (surface: WorkspaceSurface) => void;
  rememberStudioSection: (section: StudioSectionId) => void;
  rememberWorkspacePath: (path: string) => void;
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
  lastStudioSection: readStoredLastStudioSection(),
  lastWorkspacePath: readStoredLastWorkspacePath(),
  lastMonadSessionId: null,
  activeProjectId: null,
  sidebarCollapsed: readStoredSidebarCollapsed(),
  sidebarAutoReveal: false,
  pinnedProjectIds: readStoredPinnedProjectIds(),
  newProjectOpen: false,
  sessionInspectorOpen: false,
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
