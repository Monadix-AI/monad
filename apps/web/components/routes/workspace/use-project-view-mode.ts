'use client';

import { useCallback, useEffect } from 'react';
import { create } from 'zustand';

// The project's view mode — a project experience id (e.g. 'chat-room', 'graphic-view', or a future atom id).
// Shared across components — the top-bar toggle and the in-project chrome both read and switch the
// SAME mode, so e.g. the header's "jump to chat" works and every subscriber re-renders. Persisted
// per project in localStorage, so a reload keeps the last choice (a per-device view preference, not
// shared project state). Unknown ids resolve to the default project experience via the registry.
export type ProjectViewMode = string;

const DEFAULT_VIEW_MODE = 'graphic-view';
const storageKey = (projectId: string): string => `monad.projectViewMode:${projectId}`;

function normalizeMode(mode: string): ProjectViewMode {
  if (mode === 'chat') return 'chat-room';
  if (mode === 'graph') return 'graphic-view';
  return mode;
}

function loadMode(projectId: string): ProjectViewMode {
  if (typeof window === 'undefined') return DEFAULT_VIEW_MODE;
  return normalizeMode(window.localStorage.getItem(storageKey(projectId)) ?? DEFAULT_VIEW_MODE);
}

interface ViewModeStore {
  modes: Record<string, ProjectViewMode>;
  set: (projectId: string, mode: ProjectViewMode) => void;
}

const useViewModeStore = create<ViewModeStore>((set) => ({
  modes: {},
  set: (projectId, mode) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(storageKey(projectId), mode);
    set((state) => ({ modes: { ...state.modes, [projectId]: mode } }));
  }
}));

export function useProjectViewMode(projectId: string | null): [ProjectViewMode, (mode: ProjectViewMode) => void] {
  const stored = useViewModeStore((state) => (projectId ? state.modes[projectId] : undefined));
  const setInStore = useViewModeStore((state) => state.set);

  // Hydrate from localStorage after mount (kept out of render to avoid an SSR/client mismatch).
  useEffect(() => {
    if (projectId && useViewModeStore.getState().modes[projectId] === undefined) {
      setInStore(projectId, loadMode(projectId));
    }
  }, [projectId, setInStore]);

  const setMode = useCallback(
    (next: ProjectViewMode) => {
      if (projectId) setInStore(projectId, normalizeMode(next));
    },
    [projectId, setInStore]
  );

  return [stored ?? DEFAULT_VIEW_MODE, setMode];
}
