import type * as React from 'react';

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../lib/utils';

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md font-medium text-sm leading-control transition-[background-color,color,box-shadow,opacity] duration-150 ease-out outline-none disabled:pointer-events-none disabled:opacity-50 focus-visible:ring-[3px] focus-visible:ring-ring/35 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4',
  {
    variants: {
      variant: {
        default:
          'bg-accent-blue-soft text-[var(--accent-action-foreground)] hover:bg-[color-mix(in_srgb,var(--accent-blue)_28%,transparent)] active:bg-[color-mix(in_srgb,var(--accent-blue)_34%,transparent)]',
        destructive:
          'bg-destructive/10 text-[var(--destructive-action-foreground)] hover:bg-destructive/16 active:bg-destructive/22 focus-visible:ring-destructive/20 dark:bg-destructive/15 dark:hover:bg-destructive/22 dark:active:bg-destructive/28 dark:focus-visible:ring-destructive/40',
        success:
          'bg-success/10 text-[var(--success-foreground)] hover:bg-success/16 active:bg-success/22 focus-visible:ring-success/25 dark:bg-success/15 dark:hover:bg-success/22 dark:active:bg-success/28',
        warning:
          'bg-warning/20 text-[var(--warning-foreground)] hover:bg-warning/28 active:bg-warning/36 focus-visible:ring-warning/30 dark:bg-warning/15 dark:hover:bg-warning/22 dark:active:bg-warning/28',
        info: 'bg-info/12 text-[var(--info-foreground)] hover:bg-info/18 active:bg-info/24 focus-visible:ring-info/25 dark:bg-info/15 dark:hover:bg-info/22 dark:active:bg-info/28',
        outline: 'bg-background text-foreground hover:bg-muted hover:text-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground',
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
        'icon-lg': 'size-8',
        'icon-xl': 'size-[36px]'
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
