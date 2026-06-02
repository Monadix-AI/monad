import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@monad/ui';

export type SidebarAttentionBadgeState = 'need-approval' | 'need-response' | 'unread';

export function SidebarAttentionBadge({
  children,
  className,
  state,
  ...props
}: Omit<ComponentProps<'span'>, 'children'> & {
  children: ReactNode;
  state: SidebarAttentionBadgeState;
}) {
  return (
    <span
      className={cn(
        'pointer-events-none max-w-40 truncate whitespace-nowrap rounded-full px-2 py-0.5 font-medium text-[10px]',
        state === 'unread' ? 'bg-background/80 text-muted-foreground' : 'bg-info/15 text-info',
        className
      )}
      data-sidebar-attention-badge={state}
      {...props}
    >
      {children}
    </span>
  );
}
