'use client';

import type { SessionId } from '@monad/protocol';
import type { ComponentProps } from 'react';

import { SessionRoute } from '@/features/routes/sessions/SessionRoute';
import { StudioRoute } from '@/features/routes/studio/StudioRoute';
import { WorkspaceRoute } from '@/features/routes/workspace/WorkspaceRoute';

export function AppShellRoutes({
  currentSessionId,
  onCloseStudio,
  sessionRouteProps,
  showStudio,
  workspaceRouteProps
}: {
  currentSessionId: SessionId | null;
  onCloseStudio: () => void;
  sessionRouteProps: Omit<ComponentProps<typeof SessionRoute>, 'currentSessionId'>;
  showStudio: boolean;
  workspaceRouteProps: ComponentProps<typeof WorkspaceRoute>;
}) {
  if (showStudio) return <StudioRoute onClose={onCloseStudio} />;
  if (currentSessionId === null) return <WorkspaceRoute {...workspaceRouteProps} />;
  return (
    <SessionRoute
      {...sessionRouteProps}
      currentSessionId={currentSessionId}
    />
  );
}
