'use client';

import { useCallback, useEffect } from 'react';
import { create } from 'zustand';

// The project's view mode is an experience id from the daemon registry. Persisted per project in
// localStorage as a per-device preference; callers choose the runtime fallback from the current
// registry instead of baking a built-in id into the host.
export type ProjectViewMode = string;

const storageKey = (projectId: string): string => `monad.projectViewMode:${projectId}`;

function loadMode(projectId: string): ProjectViewMode | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(storageKey(projectId));
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

export function useProjectViewMode(
  projectId: string | null
): [ProjectViewMode | null, (mode: ProjectViewMode) => void] {
  const stored = useViewModeStore((state) => (projectId ? state.modes[projectId] : undefined));
  const setInStore = useViewModeStore((state) => state.set);

  // Hydrate from localStorage after mount because the value belongs to the browser runtime.
  useEffect(() => {
    if (projectId && useViewModeStore.getState().modes[projectId] === undefined) {
      const savedMode = loadMode(projectId);
      if (savedMode) setInStore(projectId, savedMode);
    }
  }, [projectId, setInStore]);

  const setMode = useCallback(
    (next: ProjectViewMode) => {
      if (projectId) setInStore(projectId, next);
    },
    [projectId, setInStore]
  );

  return [stored ?? null, setMode];
}
