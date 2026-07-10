'use client';

import type { ReactNode } from 'react';

import { ChevronDownIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { cn } from '@monad/ui';
import { useEffect, useState } from 'react';

import { CollapsiblePresence } from './collapsible-presence';
import { SIDEBAR_SECONDARY_TEXT_CLASS, SIDEBAR_SECTION_TITLE_CLASS } from './nav-item';

export function WorkspaceSection({
  action,
  children,
  collapsed,
  onToggle,
  title
}: {
  action?: ReactNode;
  children: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  title: string;
}) {
  const [motionReady, setMotionReady] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setMotionReady(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <section className="mt-2 flex flex-col gap-0.5 first:mt-0">
      <div
        className="flex min-h-7 items-center gap-1 rounded-(--radius-sm)"
        data-sidebar-tree-item="true"
      >
        <button
          aria-expanded={!collapsed}
          className={cn(
            SIDEBAR_SECTION_TITLE_CLASS,
            'flex min-h-7 min-w-0 flex-1 items-center gap-1.5 rounded-(--radius-sm) transition hover:text-muted-foreground'
          )}
          onClick={onToggle}
          title={title}
          type="button"
        >
          <span className={cn('truncate', SIDEBAR_SECONDARY_TEXT_CLASS)}>{title}</span>
          <HugeiconsIcon
            className={cn(
              'size-3 motion-reduce:transition-none',
              SIDEBAR_SECONDARY_TEXT_CLASS,
              motionReady ? 'transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]' : 'transition-none',
              collapsed ? '-rotate-90' : 'rotate-0'
            )}
            icon={ChevronDownIcon}
          />
        </button>
        {action}
      </div>
      <CollapsiblePresence collapsed={collapsed}>
        <div className="flex flex-col gap-0.5">{children}</div>
      </CollapsiblePresence>
    </section>
  );
}
