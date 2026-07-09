'use client';

import type { ReactNode } from 'react';

import { cn } from '@monad/ui';

import { AppShellSidebarHost } from './AppShellSidebarHost';
import { useShellRouteContext } from './ShellRouteProvider';

export function AppShellFrame({ children }: { children: ReactNode }) {
  const {
    frame: { isWorkspaceHome, reserveHeaderLeading },
    sidebarProps
  } = useShellRouteContext();

  return (
    <div className="app-shell relative flex h-screen overflow-hidden bg-background text-foreground">
      <AppShellSidebarHost
        onOpenWorkspace={sidebarProps.onOpenWorkspace}
        show={true}
        sidebar={sidebarProps}
      />
      <main className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          className={cn(
            'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
            isWorkspaceHome ? 'bg-background' : 'app-main-frame',
            reserveHeaderLeading && 'app-main-sidebar-collapsed'
          )}
        >
          {children}
        </div>
      </main>
    </div>
  );
}
