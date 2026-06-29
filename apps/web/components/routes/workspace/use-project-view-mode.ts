'use client';

import { useCallback, useEffect } from 'react';
import { create } from 'zustand';

// The project's view mode — a preset id (e.g. 'chat', 'graph', or a future 'atom:<pack>:<id>').
// Shared across components — the top-bar toggle and the in-project chrome both read and switch the
// SAME mode, so e.g. the header's "jump to chat" works and every subscriber re-renders. Persisted
// per project in localStorage, so a reload keeps the last choice (a per-device view preference, not
// shared project state). Unknown ids resolve to the default preset via the registry's getPreset.
export type ProjectViewMode = string;

const DEFAULT_VIEW_MODE = 'graph';
const storageKey = (projectId: string): string => `monad.projectViewMode:${projectId}`;

function loadMode(projectId: string): ProjectViewMode {
  if (typeof window === 'undefined') return DEFAULT_VIEW_MODE;
  return window.localStorage.getItem(storageKey(projectId)) ?? DEFAULT_VIEW_MODE;
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
      if (projectId) setInStore(projectId, next);
    },
    [projectId, setInStore]
  );

  return [stored ?? DEFAULT_VIEW_MODE, setMode];
}
