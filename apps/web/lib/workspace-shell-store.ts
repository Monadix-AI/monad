'use client';

import type { SessionId } from '@monad/protocol';

import { create } from 'zustand';

type WorkspaceSurface = 'workspace' | 'monadChat';

export interface WorkspaceShellState {
  surface: WorkspaceSurface;
  lastMonadSessionId: SessionId | null;
  activeProjectId: string | null;
  // Working folder chosen in the New project dialog, keyed by project slug. The session is created
  // lazily by useProject on first visit, which consumes (and clears) this so the cwd lands on it.
  pendingProjectCwd: Record<string, string>;
  setSurface: (surface: WorkspaceSurface) => void;
  rememberMonadSession: (sessionId: SessionId | null) => void;
  openWorkspace: () => void;
  openMonadChat: () => void;
  openProject: (projectId: string) => void;
  stashProjectCwd: (projectId: string, cwd: string) => void;
  takeProjectCwd: (projectId: string) => string | undefined;
}

export const useWorkspaceShellStore = create<WorkspaceShellState>()((set, get) => ({
  surface: 'workspace',
  lastMonadSessionId: null,
  activeProjectId: null,
  pendingProjectCwd: {},
  setSurface: (surface) => set({ surface }),
  rememberMonadSession: (sessionId) => set({ lastMonadSessionId: sessionId }),
  openWorkspace: () => set({ surface: 'workspace', activeProjectId: null }),
  openMonadChat: () => set({ surface: 'monadChat' }),
  openProject: (projectId) => set({ surface: 'workspace', activeProjectId: projectId }),
  stashProjectCwd: (projectId, cwd) =>
    set((state) => ({ pendingProjectCwd: { ...state.pendingProjectCwd, [projectId]: cwd } })),
  takeProjectCwd: (projectId) => {
    const cwd = get().pendingProjectCwd[projectId];
    if (cwd === undefined) return undefined;
    set((state) => {
      const { [projectId]: _, ...rest } = state.pendingProjectCwd;
      return { pendingProjectCwd: rest };
    });
    return cwd;
  }
}));
