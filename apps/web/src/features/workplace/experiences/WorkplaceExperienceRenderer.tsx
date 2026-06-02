import type { WorkplaceExperienceDefinition, WorkplaceExperienceEntry } from '@monad/protocol';
import type { ProjectExperienceView } from './types';

import { lazy, Suspense, useMemo } from 'react';

import { MonadLoading } from '#/components/MonadLoading';
import { restrictProjectExperienceView } from './restrict-view';
import { WorkplaceExperienceErrorBoundary } from './WorkplaceExperienceErrorBoundary';

const WebComponentExperience = lazy(() =>
  import('./web-component/WebComponentExperience').then((module) => ({ default: module.WebComponentExperience }))
);
const BuiltinWorkplaceExperienceHost = lazy(() =>
  import('./builtin/BuiltinWorkplaceExperience').then((module) => ({ default: module.BuiltinWorkplaceExperienceHost }))
);

type BuiltinWorkplaceExperienceDefinition = WorkplaceExperienceDefinition & {
  entry: Extract<WorkplaceExperienceEntry, { type: 'host-component' }>;
};

type WebComponentWorkplaceExperienceDefinition = WorkplaceExperienceDefinition & {
  entry: Extract<WorkplaceExperienceEntry, { type: 'web-component' }>;
};

function WorkplaceExperienceLoading(): React.ReactElement {
  return <MonadLoading className="min-h-0 flex-1" />;
}

export function WorkplaceExperienceRenderer({
  atom,
  view
}: {
  atom: WorkplaceExperienceDefinition;
  view: ProjectExperienceView;
}): React.ReactElement {
  // Single chokepoint: an experience never sees the host's full action surface, only the actions its
  // atom pack manifest was granted. The daemon stamps `atom.permissions`; the author cannot set it.
  const restrictedView = useMemo<ProjectExperienceView>(
    () => restrictProjectExperienceView(view, atom.permissions),
    [atom.permissions, view]
  );
  return (
    <WorkplaceExperienceErrorBoundary experienceId={atom.id}>
      <Suspense fallback={<WorkplaceExperienceLoading />}>
        {atom.entry.type === 'host-component' ? (
          <BuiltinWorkplaceExperienceHost
            component={(atom as BuiltinWorkplaceExperienceDefinition).entry.component}
            view={restrictedView}
          />
        ) : (
          <WebComponentExperience
            atom={atom as WebComponentWorkplaceExperienceDefinition}
            view={restrictedView}
          />
        )}
      </Suspense>
    </WorkplaceExperienceErrorBoundary>
  );
}
