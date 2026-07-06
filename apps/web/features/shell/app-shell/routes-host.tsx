'use client';

import type { AppShellRoutesProps } from '../AppShellRoutes';

import { cn } from '@monad/ui';
import { Suspense } from 'react';

import { PanelLoading } from '@/components/PanelLoading';
import { AppShellRoutes } from '../AppShellRoutes';

type AppShellRoutesHostProps = AppShellRoutesProps & {
  isWorkspaceHome: boolean;
  reserveHeaderLeading: boolean;
};

export function AppShellRoutesHost({
  currentSessionId,
  isWorkspaceHome,
  onCloseStudio,
  reserveHeaderLeading,
  sessionRouteProps,
  showStudio,
  workspaceRouteProps
}: AppShellRoutesHostProps) {
  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <div
        className={cn(
          'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
          isWorkspaceHome ? 'bg-background' : 'app-main-frame',
          reserveHeaderLeading && 'app-main-sidebar-collapsed'
        )}
      >
        <Suspense fallback={<PanelLoading />}>
          <AppShellRoutes
            currentSessionId={currentSessionId}
            onCloseStudio={onCloseStudio}
            sessionRouteProps={sessionRouteProps}
            showStudio={showStudio}
            workspaceRouteProps={workspaceRouteProps}
          />
        </Suspense>
      </div>
    </main>
  );
}
