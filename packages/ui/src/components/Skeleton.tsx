import type * as React from 'react';

import { cn } from '../lib/utils';

function Skeleton({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      aria-hidden="true"
      className={cn('block animate-pulse rounded-(--radius-sm) bg-muted motion-reduce:animate-none', className)}
      {...props}
    />
  );
}

export { Skeleton };
