import { createFileRoute } from '@tanstack/react-router';

import { useShellRouteContext } from '#/features/shell/page-shell/ShellRouteProvider';
import { WorkspaceRoute } from '#/features/workspace/WorkspaceRoute';

export const Route = createFileRoute('/_shell/')({
  component: WorkspaceRouteComponent
});

function WorkspaceRouteComponent() {
  const { workspaceRouteProps } = useShellRouteContext();
  return <WorkspaceRoute {...workspaceRouteProps} />;
}
