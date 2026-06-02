import type * as React from 'react';

import { cn } from '../lib/utils';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'field-sizing-content flex min-h-14 w-full rounded-(--radius-lg) border border-input bg-transparent px-3 py-2 text-base leading-row shadow-none outline-none transition-[background-color,border-color,box-shadow,color] duration-150 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:bg-card focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
        className
      )}
      data-slot="textarea"
      {...props}
    />
  );
}

export { Textarea };
