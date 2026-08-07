import type { ReactNode } from 'react';

import { cn, MorphChevron } from '@monad/ui';

import { CollapsiblePresence } from './collapsible-presence';
import { SIDEBAR_SECONDARY_TEXT_CLASS, SIDEBAR_SECTION_TITLE_CLASS, sidebarItemSurfaceClass } from './nav-item';
import { SidebarItemEndcap } from './sidebar-item-endcap';

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
  return (
    <section className="mt-2 flex flex-col gap-px first:mt-0">
      <div
        className={cn(
          'relative flex h-token-sidebar-row items-center gap-1 overflow-hidden rounded-(--radius-md) bg-[var(--sidebar-item-surface)]',
          sidebarItemSurfaceClass({ interactive: false })
        )}
        data-sidebar-section-item="true"
        data-sidebar-tree-item="true"
      >
        <button
          aria-expanded={!collapsed}
          className={cn(
            SIDEBAR_SECTION_TITLE_CLASS,
            'flex h-token-sidebar-row min-w-0 flex-1 items-center gap-1.5 rounded-(--radius-md) transition hover:text-muted-foreground'
          )}
          onClick={onToggle}
          title={title}
          type="button"
        >
          <span className={cn('truncate', SIDEBAR_SECONDARY_TEXT_CLASS)}>{title}</span>
          <MorphChevron
            className={cn('size-3', SIDEBAR_SECONDARY_TEXT_CLASS)}
            expanded={!collapsed}
          />
        </button>
        {action ? <SidebarItemEndcap>{action}</SidebarItemEndcap> : null}
      </div>
      <CollapsiblePresence collapsed={collapsed}>
        <div className="flex flex-col gap-px">{children}</div>
      </CollapsiblePresence>
    </section>
  );
}
