import type { ReactNode } from 'react';

import { Alert01Icon, LoaderPinwheelIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { Popover, PopoverContent, PopoverTrigger } from '#/components/ui/popover';

/** Anchored confirm for a single destructive action — mirrors ConsentPopover's
 *  trigger/content shape so both stay visually consistent. */
export function DestructiveConfirmPopover({
  children,
  description,
  confirmLabel,
  onConfirm,
  align = 'end',
  side = 'top'
}: {
  children: ReactNode;
  description: string;
  confirmLabel: string;
  onConfirm: () => Promise<unknown>;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  return (
    <Popover
      onOpenChange={setOpen}
      open={open}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align={align}
        className="w-72 p-3.5"
        side={side}
      >
        <div className="flex flex-col gap-3 text-xs">
          <div className="flex items-start gap-2">
            <HugeiconsIcon
              className="mt-0.5 size-4 shrink-0 text-destructive"
              icon={Alert01Icon}
            />
            <p className="min-w-0 text-foreground text-sm leading-5">{description}</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              disabled={pending}
              onClick={() => setOpen(false)}
              size="sm"
              variant="ghost"
            >
              {t('web.cancel')}
            </Button>
            <Button
              disabled={pending}
              onClick={async () => {
                setPending(true);
                try {
                  await onConfirm();
                  setOpen(false);
                } finally {
                  setPending(false);
                }
              }}
              size="sm"
              variant="destructive"
            >
              {pending ? (
                <HugeiconsIcon
                  className="size-3.5 animate-spin"
                  icon={LoaderPinwheelIcon}
                />
              ) : null}
              {confirmLabel}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
