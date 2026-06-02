import type * as React from 'react';

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../lib/utils';

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md border border-transparent font-medium text-sm leading-control transition-[background-color,border-color,color,box-shadow,opacity] duration-150 ease-out outline-none disabled:pointer-events-none disabled:opacity-50 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/35 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40',
        outline: 'border-border bg-background text-foreground hover:bg-muted hover:text-foreground',
        secondary: 'border-border bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground',
        ghost: 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        link: 'text-link underline-offset-4 hover:underline'
      },
      size: {
        default: 'h-7 px-2 py-0.5 has-[>svg]:px-2',
        xs: 'h-5 gap-1 px-1.5 text-xs has-[>svg]:px-1 [&_svg:not([class*=size-])]:size-3',
        sm: 'h-6 px-2 has-[>svg]:px-1.5',
        lg: 'h-8 px-4 py-1.5 text-base has-[>svg]:px-3',
        icon: 'size-7',
        'icon-xs': 'size-4 [&_svg:not([class*=size-])]:size-3',
        'icon-sm': 'size-6',
        'icon-lg': 'size-8'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      className={cn(buttonVariants({ variant, size, className }))}
      data-slot="button"
      {...props}
    />
  );
}

export { Button, buttonVariants };
