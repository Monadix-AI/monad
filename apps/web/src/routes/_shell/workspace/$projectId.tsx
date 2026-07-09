import { createFileRoute } from '@tanstack/react-router';

import { useShellRouteContext } from '#/features/shell/page-shell/ShellRouteProvider';
import { WorkspaceRoute } from '#/features/workspace/WorkspaceRoute';

export const Route = createFileRoute('/_shell/workspace/$projectId')({
  component: WorkspaceProjectRoute
});

function WorkspaceProjectRoute() {
  const { projectId } = Route.useParams();
  const { workspaceRouteProps } = useShellRouteContext();
  return (
    <WorkspaceRoute
      {...workspaceRouteProps}
      activeProjectId={projectId}
      activeProjectSessionId={null}
    />
  );
}
