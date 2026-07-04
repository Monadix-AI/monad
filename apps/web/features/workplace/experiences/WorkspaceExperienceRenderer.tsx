import type { WorkspaceExperienceDefinition, WorkspaceExperienceEntry } from '@monad/protocol';
import type { ProjectExperienceView } from './types';

import { lazy, Suspense } from 'react';

import { MonadLoading } from '@/features/init/MonadLoading';

const WebComponentExperience = lazy(() =>
  import('./web-component/WebComponentExperience').then((module) => ({ default: module.WebComponentExperience }))
);
const BuiltinWorkspaceExperienceHost = lazy(() =>
  import('./builtin/BuiltinWorkspaceExperience').then((module) => ({ default: module.BuiltinWorkspaceExperienceHost }))
);

type BuiltinWorkspaceExperienceDefinition = WorkspaceExperienceDefinition & {
  entry: Extract<WorkspaceExperienceEntry, { type: 'host-component' }>;
};

type WebComponentWorkspaceExperienceDefinition = WorkspaceExperienceDefinition & {
  entry: Extract<WorkspaceExperienceEntry, { type: 'web-component' }>;
};

function WorkspaceExperienceLoading(): React.ReactElement {
  return <MonadLoading className="min-h-0 flex-1" />;
}

export function WorkspaceExperienceRenderer({
  atom,
  view
}: {
  atom: WorkspaceExperienceDefinition;
  view: ProjectExperienceView;
}): React.ReactElement {
  return (
    <Suspense fallback={<WorkspaceExperienceLoading />}>
      {atom.entry.type === 'host-component' ? (
        <BuiltinWorkspaceExperienceHost
          component={(atom as BuiltinWorkspaceExperienceDefinition).entry.component}
          view={view}
        />
      ) : (
        <WebComponentExperience
          atom={atom as WebComponentWorkspaceExperienceDefinition}
          view={view}
        />
      )}
    </Suspense>
  );
}
