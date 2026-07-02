import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';

// One empty state for every Memory data tab (facts / graph / laws / mem0), so an empty layer reads
// the same wherever you land. Icon + a one-line what, + an optional hint for how to fill it.
export function DataEmpty({ icon: Icon, title, hint }: { icon: IconSvgElement; title: string; hint?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 py-16 text-center">
      <HugeiconsIcon
        className="size-8 text-muted-foreground/40"
        icon={Icon}
      />
      <p className="text-muted-foreground text-sm">{title}</p>
      {hint ? <p className="max-w-xs text-muted-foreground/70 text-xs">{hint}</p> : null}
    </div>
  );
}
