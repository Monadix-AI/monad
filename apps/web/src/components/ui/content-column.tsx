import type { ComponentProps, HTMLAttributes } from 'react';

import { cn, ScrollArea } from '@monad/ui';

export function ContentScrollArea({ className, ...props }: ComponentProps<typeof ScrollArea>) {
  return (
    <ScrollArea
      className={cn('[&>div>div]:!block min-w-0', className)}
      {...props}
    />
  );
}

export function ContentColumn({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-8 px-4 py-6 sm:px-6', className)}
      {...props}
    />
  );
}
