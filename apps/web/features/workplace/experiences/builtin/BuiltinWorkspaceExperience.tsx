import type { ProjectExperienceView } from '../types';

import {
  configureBuiltinWorkspaceExperienceClients,
  renderBuiltinWorkspaceExperience
} from '@monad/atoms/workspace-experiences';
import { useRouter } from 'next/navigation';

import { studioPath } from '@/features/routes/route-paths';
import { useMonadRuntime } from '@/lib/monad-runtime-provider';
import { useWorkplaceUiStore } from '../../workplace-ui-store';

export function BuiltinWorkspaceExperienceHost({
  component,
  view
}: {
  component: string;
  view: ProjectExperienceView;
}): React.ReactElement {
  const { client } = useMonadRuntime();
  const router = useRouter();
  const openProjectSettings = useWorkplaceUiStore((state) => state.openProjectSettings);
  configureBuiltinWorkspaceExperienceClients({
    fetch: client.fetch,
    openModelSettings: () => router.push(studioPath('models'))
  });
  const rendered = renderBuiltinWorkspaceExperience({
    component,
    host: {
      nativeCliAgentsHref: studioPath('nativeCliAgents'),
      openSpawnAgentMember: (projectId) => openProjectSettings(projectId, 'spawn-agent'),
      voiceModelState: view.voiceModelState
    },
    view: { runtime: view.runtime }
  });
  if (!rendered) {
    return <div className="workspace-experience-error">Unknown built-in workspace experience: {component}</div>;
  }
  return rendered;
}
