import type { ProjectExperienceView } from '../types';

import { renderBuiltinWorkspaceExperience } from '@monad/atoms/workspace-experiences';
import {
  type WorkspaceExperienceHost,
  WorkspaceExperienceHostProvider
} from '@monad/atoms/workspace-experiences/host-context';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';

import { studioPath } from '@/features/routes/route-paths';
import { useMonadRuntime } from '@/lib/monad-runtime-provider';

export function BuiltinWorkspaceExperienceHost({
  component,
  view
}: {
  component: string;
  view: ProjectExperienceView;
}): React.ReactElement {
  const { client } = useMonadRuntime();
  const router = useRouter();
  const host = useMemo<WorkspaceExperienceHost>(
    () => ({
      fetch: client.fetch,
      voiceModelState: view.voiceModelState,
      openStudio: (section = 'models') => router.push(studioPath(section)),
      requestProjectDialog: view.onProjectDialogRequest ?? (() => {})
    }),
    [client.fetch, router, view.voiceModelState, view.onProjectDialogRequest]
  );
  const rendered = renderBuiltinWorkspaceExperience({ component, view: { runtime: view.runtime } });
  if (!rendered) {
    return <div className="workspace-experience-error">Unknown built-in workspace experience: {component}</div>;
  }
  return <WorkspaceExperienceHostProvider value={host}>{rendered}</WorkspaceExperienceHostProvider>;
}
