'use client';

import { cn } from '../lib/utils';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  className?: string;
}

/**
 * Boolean toggle. Native button (no extra radix dep) with role="switch". Track is `--primary`
 * when on, `--input` when off; thumb slides 150ms ease-out. Honors `prefers-reduced-motion`
 * via the global transition reset.
 */
export function Switch({ checked, onCheckedChange, disabled, className, ...aria }: SwitchProps) {
  return (
    <button
      aria-checked={checked}
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent outline-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-input',
        className
      )}
      data-slot="switch"
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      role="switch"
      type="button"
      {...aria}
    >
      <span
        className={cn(
          'pointer-events-none block size-4 rounded-full bg-background shadow-sm ring-0 transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5'
        )}
      />
    </button>
  );
}
