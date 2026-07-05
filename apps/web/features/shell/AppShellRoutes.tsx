'use client';

import type { SessionId } from '@monad/protocol';
import type { ComponentProps } from 'react';
import type { SessionRouteProps } from '@/features/routes/sessions/SessionRoute';

import dynamic from 'next/dynamic';

import { StudioRoute } from '@/features/routes/studio/StudioRoute';
import { WorkspaceRoute } from '@/features/routes/workspace/WorkspaceRoute';

const SessionRoute = dynamic(() => import('@/features/routes/sessions/SessionRoute').then((m) => m.SessionRoute));

export function AppShellRoutes({
  currentSessionId,
  onCloseStudio,
  sessionRouteProps,
  showStudio,
  workspaceRouteProps
}: {
  currentSessionId: SessionId | null;
  onCloseStudio: () => void;
  sessionRouteProps: Omit<SessionRouteProps, 'currentSessionId'>;
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
