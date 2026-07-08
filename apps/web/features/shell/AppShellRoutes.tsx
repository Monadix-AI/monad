'use client';

import type { SessionId } from '@monad/protocol';
import type { ComponentProps } from 'react';
import type { SessionRouteProps } from '#/features/routes/sessions/SessionRoute';

import dynamic from 'next/dynamic';
import { memo } from 'react';

import { PanelLoading } from '#/components/PanelLoading';
import { StudioRoute } from '#/features/routes/studio/StudioRoute';
import { WorkspaceRoute } from '#/features/routes/workspace/WorkspaceRoute';
import { Settings } from '#/features/settings/Settings';

const SessionRoute = dynamic(() => import('#/features/routes/sessions/SessionRoute').then((m) => m.SessionRoute), {
  loading: PanelLoading
});

export type AppShellRoutesProps = {
  currentSessionId: SessionId | null;
  onCloseStudio: () => void;
  settingsRouteProps: ComponentProps<typeof Settings>;
  sessionRouteProps: Omit<SessionRouteProps, 'currentSessionId'>;
  showSettings: boolean;
  showStudio: boolean;
  workspaceRouteProps: ComponentProps<typeof WorkspaceRoute>;
};

export const AppShellRoutes = memo(function AppShellRoutes({
  currentSessionId,
  onCloseStudio,
  settingsRouteProps,
  sessionRouteProps,
  showSettings,
  showStudio,
  workspaceRouteProps
}: AppShellRoutesProps) {
  if (showSettings) return <Settings {...settingsRouteProps} />;
  if (showStudio) return <StudioRoute onClose={onCloseStudio} />;
  if (currentSessionId === null) return <WorkspaceRoute {...workspaceRouteProps} />;
  return (
    <SessionRoute
      {...sessionRouteProps}
      currentSessionId={currentSessionId}
    />
  );
}, areAppShellRoutesPropsEqual);

function areAppShellRoutesPropsEqual(prev: AppShellRoutesProps, next: AppShellRoutesProps): boolean {
  if (
    prev.showSettings !== next.showSettings ||
    prev.showStudio !== next.showStudio ||
    prev.currentSessionId !== next.currentSessionId
  )
    return false;
  if (next.showSettings) {
    return (
      prev.settingsRouteProps.initialSection === next.settingsRouteProps.initialSection &&
      prev.settingsRouteProps.onClose === next.settingsRouteProps.onClose
    );
  }
  if (next.showStudio) return prev.onCloseStudio === next.onCloseStudio;
  if (next.currentSessionId !== null) return false;
  return areWorkspaceRoutePropsEqual(prev.workspaceRouteProps, next.workspaceRouteProps);
}

function areWorkspaceRoutePropsEqual(
  prev: AppShellRoutesProps['workspaceRouteProps'],
  next: AppShellRoutesProps['workspaceRouteProps']
): boolean {
  return (
    prev.activeProjectId === next.activeProjectId &&
    prev.agentSession === next.agentSession &&
    prev.projects === next.projects &&
    prev.onNewAgentChat === next.onNewAgentChat &&
    prev.onNewProject === next.onNewProject &&
    prev.onOpenAgentChat === next.onOpenAgentChat &&
    prev.onOpenProject === next.onOpenProject &&
    prev.onProjectDeleted === next.onProjectDeleted &&
    prev.onOpenSettings === next.onOpenSettings &&
    prev.onOpenStudio === next.onOpenStudio &&
    prev.voiceModelState === next.voiceModelState
  );
}
