import type { ChannelIcon } from '@monad/protocol';

import { MessageMultiple01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { cn } from '@monad/ui';

import { BrandIcon } from '#/components/BrandIcon';

export function ChannelBrandIcon({
  className,
  icon,
  iconClassName
}: {
  className?: string;
  icon?: ChannelIcon;
  iconClassName?: string;
}) {
  if (!icon) {
    return (
      <span
        className={cn('grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground', className)}
      >
        <HugeiconsIcon
          className={cn('size-5', iconClassName)}
          icon={MessageMultiple01Icon}
        />
      </span>
    );
  }

  return (
    <span
      className={cn('grid size-9 shrink-0 place-items-center rounded-lg bg-muted/60 text-muted-foreground', className)}
    >
      <BrandIcon
        className={cn('size-5', iconClassName)}
        icon={icon}
      />
    </span>
  );
}
