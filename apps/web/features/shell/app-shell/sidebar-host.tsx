'use client';

import type { ComponentProps } from 'react';

import { AppShellSidebarReveal } from '../AppShellSidebarReveal';
import { SessionSidebar } from '../SessionSidebar';

type AppShellSidebarHostProps = {
  reveal: ComponentProps<typeof AppShellSidebarReveal>;
  sidebar: ComponentProps<typeof SessionSidebar>;
  show: boolean;
};

export function AppShellSidebarHost({ reveal, sidebar, show }: AppShellSidebarHostProps) {
  if (!show) return null;
  return (
    <>
      <AppShellSidebarReveal {...reveal} />
      <SessionSidebar {...sidebar} />
    </>
  );
}
