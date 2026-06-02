'use client';

import { useCallback, useEffect, useState } from 'react';

// Remembers the project's view mode (graph vs chat) per project, so a reload keeps the last choice.
// Client-local on purpose: it's a per-device view preference, not shared project state.
export type ProjectViewMode = 'graph' | 'chat';

const storageKey = (projectId: string): string => `monad.projectViewMode:${projectId}`;

function loadMode(projectId: string | null): ProjectViewMode {
  if (typeof window === 'undefined' || !projectId) return 'graph';
  const stored = window.localStorage.getItem(storageKey(projectId));
  return stored === 'chat' || stored === 'graph' ? stored : 'graph';
}

export function useProjectViewMode(projectId: string | null): [ProjectViewMode, (mode: ProjectViewMode) => void] {
  const [mode, setMode] = useState<ProjectViewMode>(() => loadMode(projectId));

  // Re-sync when navigating between projects (the component is not remounted per project).
  useEffect(() => {
    setMode(loadMode(projectId));
  }, [projectId]);

  const setAndPersist = useCallback(
    (next: ProjectViewMode) => {
      setMode(next);
      if (typeof window !== 'undefined' && projectId) window.localStorage.setItem(storageKey(projectId), next);
    },
    [projectId]
  );

  return [mode, setAndPersist];
}
