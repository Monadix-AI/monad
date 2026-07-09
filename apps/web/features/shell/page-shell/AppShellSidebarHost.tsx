'use client';

import type { ComponentProps } from 'react';

import { AppShellSidebarReveal } from '#/features/shell/AppShellSidebarReveal';
import { SessionSidebar } from '#/features/shell/SessionSidebar';

type AppShellSidebarHostProps = {
  onOpenWorkspace: ComponentProps<typeof AppShellSidebarReveal>['onOpenWorkspace'];
  sidebar: ComponentProps<typeof SessionSidebar>;
  show: boolean;
};

export function AppShellSidebarHost({ onOpenWorkspace, sidebar, show }: AppShellSidebarHostProps) {
  if (!show) return null;
  return (
    <>
      <AppShellSidebarReveal onOpenWorkspace={onOpenWorkspace} />
      <SessionSidebar {...sidebar} />
    </>
  );
}
