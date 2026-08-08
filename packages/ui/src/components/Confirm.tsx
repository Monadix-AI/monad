import type * as React from 'react';

import { useEffect, useRef } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from './AlertDialog';
import { Button } from './Button';
import { dialogBodyClassName } from './dialog-styles';
import { Spinner } from './Spinner';

export interface ConfirmProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  cancelLabel: React.ReactNode;
  confirmLabel: React.ReactNode;
  pendingLabel?: React.ReactNode;
  pending?: boolean;
  error?: React.ReactNode;
  confirmVariant?: 'default' | 'destructive';
  confirmDisabled?: boolean;
  onConfirm: () => void;
}

export function resolveConfirmOpenChange(pending: boolean, open: boolean): boolean | null {
  return pending && !open ? null : open;
}

export function resolveConfirmActionLabel(
  pending: boolean,
  confirmLabel: React.ReactNode,
  pendingLabel?: React.ReactNode
): React.ReactNode {
  return pending ? (pendingLabel ?? confirmLabel) : confirmLabel;
}

function Confirm({
  open,
  onOpenChange,
  title,
  description,
  children,
  cancelLabel,
  confirmLabel,
  pendingLabel,
  pending = false,
  error,
  confirmVariant = 'default',
  confirmDisabled = false,
  onConfirm
}: ConfirmProps) {
  const submittingRef = useRef(false);

  useEffect(() => {
    if (!open || !pending) submittingRef.current = false;
  }, [open, pending]);

  const handleOpenChange = (nextOpen: boolean) => {
    const resolved = resolveConfirmOpenChange(pending, nextOpen);
    if (resolved !== null) onOpenChange(resolved);
  };

  return (
    <AlertDialog
      onOpenChange={handleOpenChange}
      open={open}
    >
      <AlertDialogContent
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        {children || error ? (
          <div className={dialogBodyClassName}>
            {children}
            {error ? (
              <div
                className="rounded-md bg-destructive/10 px-3 py-2 text-destructive text-sm"
                role="alert"
              >
                {error}
              </div>
            ) : null}
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button
              disabled={pending || confirmDisabled}
              type="button"
              variant="outline"
            >
              {cancelLabel}
            </Button>
          </AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button
              disabled={pending}
              onClick={(event) => {
                event.preventDefault();
                if (pending || submittingRef.current) return;
                submittingRef.current = true;
                try {
                  onConfirm();
                } catch (error) {
                  submittingRef.current = false;
                  throw error;
                }
              }}
              type="button"
              variant={confirmVariant}
            >
              {pending ? <Spinner aria-hidden="true" /> : null}
              {resolveConfirmActionLabel(pending, confirmLabel, pendingLabel)}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export { Confirm };
