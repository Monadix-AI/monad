import type * as React from 'react';

import { cn } from '../lib/utils';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'flex h-8 w-full min-w-0 rounded-(--radius-sm) border border-input bg-transparent px-2.5 py-1 text-base leading-control shadow-none outline-none transition-[background-color,border-color,box-shadow,color] duration-150 selection:bg-accent-blue-soft file:inline-flex file:h-6 file:border-0 file:bg-transparent file:font-medium file:text-foreground file:text-sm placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:border-ring focus-visible:bg-card focus-visible:ring-[3px] focus-visible:ring-ring/30',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
        className
      )}
      data-slot="input"
      type={type}
      {...props}
    />
  );
}

export { Input };
