'use client';

import { useCallback, useEffect } from 'react';
import { create } from 'zustand';

// The project's view mode is an experience id from the daemon registry. Persisted per project in
// localStorage as a per-device preference; callers choose the runtime fallback from the current
// registry instead of baking a built-in id into the host.
export type ProjectViewMode = string;

export function projectViewModeStorageKey({
  projectId,
  sessionId
}: {
  projectId: string | null;
  sessionId: string | null;
}): string | null {
  if (sessionId) return `monad.projectViewMode.session:${sessionId}`;
  if (projectId) return `monad.projectViewMode:${projectId}`;
  return null;
}

function loadMode(key: string): ProjectViewMode | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(key);
}

interface ViewModeStore {
  modes: Record<string, ProjectViewMode>;
  set: (key: string, mode: ProjectViewMode) => void;
}

const useViewModeStore = create<ViewModeStore>((set) => ({
  modes: {},
  set: (key, mode) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, mode);
    set((state) => ({ modes: { ...state.modes, [key]: mode } }));
  }
}));

export function useProjectViewMode(
  projectId: string | null,
  sessionId: string | null = null
): [ProjectViewMode | null, (mode: ProjectViewMode) => void] {
  const key = projectViewModeStorageKey({ projectId, sessionId });
  const stored = useViewModeStore((state) => (key ? state.modes[key] : undefined));
  const setInStore = useViewModeStore((state) => state.set);

  // Hydrate from localStorage after mount because the value belongs to the browser runtime.
  useEffect(() => {
    if (key && useViewModeStore.getState().modes[key] === undefined) {
      const savedMode = loadMode(key);
      if (savedMode) setInStore(key, savedMode);
    }
  }, [key, setInStore]);

  const setMode = useCallback(
    (next: ProjectViewMode) => {
      if (key) setInStore(key, next);
    },
    [key, setInStore]
  );

  return [stored ?? null, setMode];
}
