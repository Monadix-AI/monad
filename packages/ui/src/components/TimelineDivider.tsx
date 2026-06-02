import type { ReactNode } from 'react';

import { cn } from '../lib/utils';

export interface TimelineDividerProps {
  children: ReactNode;
  className?: string;
}

export function TimelineDivider({ children, className }: TimelineDividerProps) {
  return (
    <div className={cn('flex items-center gap-3 self-stretch py-1 text-muted-foreground', className)}>
      <div
        aria-hidden
        className="h-px flex-1 bg-border/70"
      />
      <div className="flex items-center gap-2">{children}</div>
      <div
        aria-hidden
        className="h-px flex-1 bg-border/70"
      />
    </div>
  );
}
