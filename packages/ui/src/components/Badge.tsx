import type * as React from 'react';

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../lib/utils';

const badgeVariants = cva(
  'label-mono inline-flex w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-(--radius-pill) border px-2.5 py-1 [&>svg]:size-3 [&>svg]:pointer-events-none overflow-hidden transition-[color,box-shadow,border-color,background-color] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground [a&]:hover:opacity-90',
        secondary: 'border-border bg-secondary text-secondary-foreground [a&]:hover:bg-accent',
        destructive:
          'border-transparent bg-destructive text-destructive-foreground [a&]:hover:opacity-90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40',
        outline: 'border-border bg-transparent text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground'
      }
    },
    defaultVariants: {
      variant: 'default'
    }
  }
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'span';
  return (
    <Comp
      className={cn(badgeVariants({ variant }), className)}
      data-slot="badge"
      {...props}
    />
  );
}

export { Badge, badgeVariants };
