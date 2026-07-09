import dynamic from 'next/dynamic';

import { PanelLoading } from '#/components/PanelLoading';
import { StudioRoute } from '#/features/routes/studio/StudioRoute';
import { WorkspaceRoute } from '#/features/routes/workspace/WorkspaceRoute';
import { Settings } from '#/features/settings/Settings';
import { AppShellFrame } from '#/features/shell/page-shell/AppShellFrame';
import { ShellRouteProvider, useShellRouteContext } from '#/features/shell/page-shell/ShellRouteProvider';

const SessionRoute = dynamic(() => import('#/features/routes/sessions/SessionRoute').then((m) => m.SessionRoute), {
  loading: PanelLoading
});

export default function ShellPage() {
  return (
    <ShellRouteProvider>
      <AppShellFrame>
        <ShellRouteOutlet />
      </AppShellFrame>
    </ShellRouteProvider>
  );
}

function ShellRouteOutlet() {
  const { currentSessionId, onCloseStudio, sessionRouteProps, settingsRouteProps, shellRoute, workspaceRouteProps } =
    useShellRouteContext();

  if (shellRoute.isSettingsRoute) return <Settings {...settingsRouteProps} />;
  if (shellRoute.isStudioRoute) return <StudioRoute onClose={onCloseStudio} />;
  if (currentSessionId && !workspaceRouteProps.activeProjectId) {
    return (
      <SessionRoute
        {...sessionRouteProps}
        currentSessionId={currentSessionId}
      />
    );
  }
  return <WorkspaceRoute {...workspaceRouteProps} />;
}
