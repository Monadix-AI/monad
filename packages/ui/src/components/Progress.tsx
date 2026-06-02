'use client';

import type * as React from 'react';

import { cn } from '../lib/utils';

function Progress({ className, value, ...props }: React.ComponentProps<'div'> & { value?: number | null }) {
  return (
    <div
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={value ?? undefined}
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-primary/20', className)}
      data-slot="progress"
      role="progressbar"
      {...props}
    >
      <div
        className="h-full w-full flex-1 bg-primary transition-all"
        data-slot="progress-indicator"
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </div>
  );
}

export { Progress };
