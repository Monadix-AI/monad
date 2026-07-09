'use client';

import type { TFunction } from './types';

const SHELL_HEADER_HEIGHT = 52;

export function SidebarHeader({
  collapsed
}: {
  collapsed: boolean;
  onOpenWorkspace: () => void;
  onToggleCollapsed: () => void;
  t: TFunction;
}) {
  return (
    <div
      className="flex shrink-0 items-center px-3"
      style={{ height: SHELL_HEADER_HEIGHT }}
    >
      {collapsed ? null : <div className="min-w-0 flex-1" />}
    </div>
  );
}
