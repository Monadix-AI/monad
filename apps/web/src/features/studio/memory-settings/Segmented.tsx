import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { cn } from '@monad/ui';

// A compact pill toggle — the Memory panel's primary affordance for mutually-exclusive choices
// (active tab, backend, fact scope). The active segment sits raised on the surface; the rest recede.
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className
}: {
  options: { value: T; label: string; icon?: IconSvgElement }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('inline-flex rounded-lg border bg-muted/50 p-0.5', className)}>
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium text-sm transition-colors',
              active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            )}
            key={o.value}
            onClick={() => onChange(o.value)}
            type="button"
          >
            {o.icon ? (
              <HugeiconsIcon
                className="size-4"
                icon={o.icon}
              />
            ) : null}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
