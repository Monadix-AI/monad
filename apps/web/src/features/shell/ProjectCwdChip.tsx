import { Cancel01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

interface ProjectCwdChipProps {
  disabled?: boolean;
  onRemove?: () => void;
  path: string;
  removeLabel?: string;
}

function cwdName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function ProjectCwdChip({
  disabled = false,
  onRemove,
  path,
  removeLabel
}: ProjectCwdChipProps): React.ReactElement {
  const removable = Boolean(onRemove && removeLabel);
  return (
    <div
      className="group relative inline-flex h-8 w-fit max-w-full items-center justify-center rounded-full border border-border bg-secondary px-3 py-0.5 text-foreground"
      title={path}
    >
      <span className="min-w-0 truncate text-center font-mono text-xs">{cwdName(path)}</span>
      {removable ? (
        <button
          aria-label={removeLabel}
          className="absolute -top-1 -right-1 inline-flex size-4 items-center justify-center rounded-full bg-secondary text-muted-foreground opacity-0 outline-none transition-[background-color,color,opacity] before:absolute before:-inset-1 hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:ring-2 focus-visible:ring-ring/40 group-focus-within:opacity-100 group-hover:opacity-100 [@media_(hover:none),_(pointer:coarse)]:opacity-100"
          disabled={disabled}
          onClick={onRemove}
          type="button"
        >
          <HugeiconsIcon
            className="size-2.5"
            icon={Cancel01Icon}
          />
        </button>
      ) : null}
    </div>
  );
}
