import type { SessionId } from '@monad/protocol';

import { createFileRoute } from '@tanstack/react-router';

import { useShellRouteContext } from '#/features/shell/page-shell/ShellRouteProvider';
import { WorkspaceRoute } from '#/features/workspace/WorkspaceRoute';

export const Route = createFileRoute('/_shell/workspace/$projectId/$sessionId')({
  component: WorkspaceProjectSessionRoute
});

function WorkspaceProjectSessionRoute() {
  const { projectId, sessionId } = Route.useParams();
  const { workspaceRouteProps } = useShellRouteContext();
  return (
    <WorkspaceRoute
      {...workspaceRouteProps}
      activeProjectId={projectId}
      activeProjectSessionId={sessionId as SessionId}
    />
  );
}
