import type { IconSvgElement } from '@hugeicons/react';

import { Settings02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Card, Switch } from '@monad/ui';

export function ToolCard({
  description,
  enabled,
  icon: Icon,
  name,
  onConfigure,
  onToggle,
  optional,
  summary
}: {
  description: string;
  enabled?: boolean;
  icon: IconSvgElement;
  name: string;
  onConfigure?: () => void;
  onToggle?: (v: boolean) => void;
  optional?: boolean;
  summary: string;
}) {
  return (
    <Card
      className={`flex flex-col gap-3 p-4 transition-colors${onConfigure ? 'cursor-pointer hover:bg-muted/20' : ''}`}
      onClick={onConfigure}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="rounded-md bg-muted/50 p-1.5">
            <HugeiconsIcon
              className="size-4 text-foreground/70"
              icon={Icon}
            />
          </div>
          <span className="font-medium text-sm">{name}</span>
        </div>
        {optional && onToggle && (
          // biome-ignore lint/a11y/noStaticElementInteractions: prevents the switch click from opening the config card.
          <div
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
          >
            <Switch
              checked={enabled ?? false}
              onCheckedChange={onToggle}
            />
          </div>
        )}
      </div>
      <p className="text-muted-foreground text-xs leading-relaxed">{description}</p>
      <div className="mt-auto flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[11px] text-muted-foreground/60">{summary}</span>
        {onConfigure && (
          <HugeiconsIcon
            className="size-3.5 shrink-0 text-muted-foreground/40"
            icon={Settings02Icon}
          />
        )}
      </div>
    </Card>
  );
}
