import type * as React from 'react';

import { LoaderPinwheelIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

import { cn } from '../lib/utils';

function Spinner({ className, strokeWidth, ...props }: React.ComponentProps<'svg'>) {
  const resolvedStrokeWidth = typeof strokeWidth === 'string' ? Number(strokeWidth) : strokeWidth;
  return (
    <HugeiconsIcon
      aria-label="Loading"
      className={cn('size-4 animate-spin', className)}
      icon={LoaderPinwheelIcon}
      role="status"
      strokeWidth={Number.isNaN(resolvedStrokeWidth) ? undefined : resolvedStrokeWidth}
      {...props}
    />
  );
}

export { Spinner };
