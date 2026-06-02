import type * as React from 'react';

import { AlertDialog as AlertDialogPrimitive } from 'radix-ui';

import { cn } from '../lib/utils';

function AlertDialog(props: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return (
    <AlertDialogPrimitive.Root
      data-slot="alert-dialog"
      {...props}
    />
  );
}

function AlertDialogTrigger(props: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return (
    <AlertDialogPrimitive.Trigger
      data-slot="alert-dialog-trigger"
      {...props}
    />
  );
}

function AlertDialogPortal(props: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return (
    <AlertDialogPrimitive.Portal
      data-slot="alert-dialog-portal"
      {...props}
    />
  );
}

function AlertDialogOverlay({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return (
    <AlertDialogPrimitive.Overlay
      className={cn(
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-40 bg-white/35 backdrop-blur-[2px] backdrop-saturate-125 data-[state=closed]:animate-out data-[state=open]:animate-in dark:bg-black/45',
        className
      )}
      data-slot="alert-dialog-overlay"
      {...props}
    />
  );
}

function AlertDialogContent({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        className={cn(
          'glass-surface data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 flex max-h-[min(42rem,calc(100dvh-2rem))] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] flex-col gap-0 overflow-hidden p-0 outline-none duration-200 data-[state=closed]:animate-out data-[state=open]:animate-in sm:max-w-lg',
          className
        )}
        data-slot="alert-dialog-content"
        {...props}
      />
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex shrink-0 flex-col gap-1.5 px-5 pt-5 pb-4 text-left', className)}
      data-slot="alert-dialog-header"
      {...props}
    />
  );
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex shrink-0 flex-col-reverse gap-2 border-border/70 border-t bg-muted/15 px-5 py-4 sm:flex-row sm:justify-end',
        className
      )}
      data-slot="alert-dialog-footer"
      {...props}
    />
  );
}

function AlertDialogTitle({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      className={cn('font-semibold text-lg leading-none', className)}
      data-slot="alert-dialog-title"
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      className={cn('text-muted-foreground text-sm', className)}
      data-slot="alert-dialog-description"
      {...props}
    />
  );
}

function AlertDialogAction(props: React.ComponentProps<typeof AlertDialogPrimitive.Action>) {
  return (
    <AlertDialogPrimitive.Action
      data-slot="alert-dialog-action"
      {...props}
    />
  );
}

function AlertDialogCancel(props: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  return (
    <AlertDialogPrimitive.Cancel
      data-slot="alert-dialog-cancel"
      {...props}
    />
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger
};
