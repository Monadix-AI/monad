import type * as React from 'react';

import { Cancel01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Dialog as DialogPrimitive } from 'radix-ui';

import { cn } from '../lib/utils';
import { Button } from './Button';

const dialogContentVariants = cva(
  'glass-surface data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 flex max-h-[min(42rem,calc(100dvh-2rem))] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] flex-col gap-0 overflow-hidden p-0 outline-none duration-200 data-[state=closed]:animate-out data-[state=open]:animate-in',
  {
    defaultVariants: { size: 'md' },
    variants: {
      size: {
        sm: 'sm:max-w-md',
        md: 'sm:max-w-lg',
        lg: 'sm:max-w-xl',
        xl: 'sm:max-w-3xl',
        wide: 'sm:max-w-5xl'
      }
    }
  }
);

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return (
    <DialogPrimitive.Root
      data-slot="dialog"
      {...props}
    />
  );
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return (
    <DialogPrimitive.Trigger
      data-slot="dialog-trigger"
      {...props}
    />
  );
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return (
    <DialogPrimitive.Portal
      data-slot="dialog-portal"
      {...props}
    />
  );
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return (
    <DialogPrimitive.Close
      data-slot="dialog-close"
      {...props}
    />
  );
}

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-40 bg-white/35 backdrop-blur-[2px] backdrop-saturate-125 data-[state=closed]:animate-out data-[state=open]:animate-in dark:bg-black/45',
        className
      )}
      data-slot="dialog-overlay"
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  closeLabel = 'Close',
  overlayClassName,
  overlayStyle,
  size,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  closeLabel?: string;
  overlayClassName?: string;
  overlayStyle?: React.CSSProperties;
  showCloseButton?: boolean;
} & VariantProps<typeof dialogContentVariants>) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay
        className={overlayClassName}
        style={overlayStyle}
      />
      <DialogPrimitive.Content
        className={cn(dialogContentVariants({ size }), className)}
        data-slot="dialog-content"
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"
            data-slot="dialog-close"
          >
            <HugeiconsIcon icon={Cancel01Icon} />
            <span className="sr-only">{closeLabel}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex shrink-0 flex-col gap-1.5 px-5 pt-5 pr-12 pb-4 text-left', className)}
      data-slot="dialog-header"
      {...props}
    />
  );
}

function DialogBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4', className)}
      data-slot="dialog-body"
      {...props}
    />
  );
}

function DialogFooter({
  className,
  closeLabel = 'Close',
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  closeLabel?: string;
  showCloseButton?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex shrink-0 flex-col-reverse gap-2 border-border/70 border-t bg-muted/15 px-5 py-4 sm:flex-row sm:justify-end',
        className
      )}
      data-slot="dialog-footer"
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">{closeLabel}</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn('font-semibold text-lg leading-none', className)}
      data-slot="dialog-title"
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn('text-muted-foreground text-sm', className)}
      data-slot="dialog-description"
      {...props}
    />
  );
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  dialogContentVariants
};
