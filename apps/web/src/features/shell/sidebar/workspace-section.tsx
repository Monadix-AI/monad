import type { ReactNode } from 'react';

import { cn, MorphChevron } from '@monad/ui';

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
          <MorphChevron
            className={cn('size-3', SIDEBAR_SECONDARY_TEXT_CLASS)}
            expanded={!collapsed}
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
