import type { ProjectExperienceRuntimeSource } from '@monad/atoms/workplace-experiences';

import { useProjectExperienceRuntime } from '@monad/atoms/workplace-experiences';
import { useMemo } from 'react';

export function useWorkspaceProjectExperienceRuntime(
  source: ProjectExperienceRuntimeSource,
  opts: {
    openAgentCard?: (id: string) => void;
    switchExperience?: (id: string) => void;
  }
) {
  const runtimeOpts = useMemo(
    () => ({
      openAgentCard: opts.openAgentCard,
      switchExperience: opts.switchExperience ?? (() => {})
    }),
    [opts.openAgentCard, opts.switchExperience]
  );
  return useProjectExperienceRuntime(source, runtimeOpts);
}
