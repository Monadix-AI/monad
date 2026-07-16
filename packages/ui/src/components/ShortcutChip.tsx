import type { ComponentProps } from 'react';

import { cn } from '../lib/utils';

export type ShortcutChipProps = ComponentProps<'kbd'>;

export function ShortcutChip({ className, ...props }: ShortcutChipProps) {
  return (
    <kbd
      className={cn(
        'inline-flex h-4 min-w-7 shrink-0 items-center justify-center gap-px whitespace-nowrap rounded-full bg-sidebar-accent/85 px-1.5 font-medium text-[10px] text-muted-foreground tabular-nums shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] backdrop-blur',
        className
      )}
      data-slot="shortcut-chip"
      translate="no"
      {...props}
    />
  );
}
