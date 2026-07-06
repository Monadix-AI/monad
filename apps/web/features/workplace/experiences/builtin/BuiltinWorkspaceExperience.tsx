import type { ProjectExperienceView } from '../types';

import { renderBuiltinWorkspaceExperience } from '@monad/atoms/workspace-experiences';
import {
  type WorkspaceExperienceHost,
  WorkspaceExperienceHostProvider
} from '@monad/atoms/workspace-experiences/host-context';
import { useMemo } from 'react';

import { studioPath } from '@/features/routes/route-paths';
import { pushShellUrl } from '@/hooks/use-shell-location';

export function BuiltinWorkspaceExperienceHost({
  component,
  view
}: {
  component: string;
  view: ProjectExperienceView;
}): React.ReactElement {
  const host = useMemo<WorkspaceExperienceHost>(
    () => ({
      voiceModelState: view.voiceModelState,
      openStudio: (section = 'models') => pushShellUrl(studioPath(section)),
      requestProjectDialog: view.onProjectDialogRequest ?? (() => {})
    }),
    [view.voiceModelState, view.onProjectDialogRequest]
  );
  const rendered = renderBuiltinWorkspaceExperience({ component, view: { runtime: view.runtime } });
  if (!rendered) {
    return <div className="workspace-experience-error">Unknown built-in workspace experience: {component}</div>;
  }
  return <WorkspaceExperienceHostProvider value={host}>{rendered}</WorkspaceExperienceHostProvider>;
}
