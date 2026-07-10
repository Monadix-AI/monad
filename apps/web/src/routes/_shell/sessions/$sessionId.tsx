import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { PanelLoading } from '#/components/PanelLoading';
import { useShellRouteContext } from '#/features/shell/page-shell/ShellRouteProvider';
import { WorkspaceRoute } from '#/features/workspace/WorkspaceRoute';

const SessionRoute = lazy(() => import('#/features/session/SessionRoute').then((m) => ({ default: m.SessionRoute })));

export const Route = createFileRoute('/_shell/sessions/$sessionId')({
  component: SessionRouteComponent
});

function SessionRouteComponent() {
  const { sessionRouteModel, workspaceRouteProps } = useShellRouteContext();

  if (!sessionRouteModel) {
    return <WorkspaceRoute {...workspaceRouteProps} />;
  }

  return (
    <Suspense fallback={<PanelLoading />}>
      <SessionRoute model={sessionRouteModel} />
    </Suspense>
  );
}
