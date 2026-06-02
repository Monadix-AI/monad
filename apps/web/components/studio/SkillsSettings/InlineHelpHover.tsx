import type { ReactNode } from 'react';

import { Button } from '@monad/ui';
import { HelpCircle } from 'lucide-react';

import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';

export function InlineHelpHover({
  body,
  icon,
  label,
  sections,
  title
}: {
  body: string;
  icon: ReactNode;
  label: string;
  sections: string[];
  title: string;
}) {
  return (
    <HoverCard
      closeDelay={80}
      openDelay={120}
    >
      <HoverCardTrigger asChild>
        <Button
          aria-label={label}
          className="size-6"
          size="icon"
          variant="ghost"
        >
          <HelpCircle className="size-3.5" />
        </Button>
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        className="w-80 p-4"
        side="bottom"
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2">
            {icon}
            <div className="min-w-0">
              <div className="font-medium text-sm leading-5">{title}</div>
              <p className="mt-1 text-muted-foreground text-xs leading-5">{body}</p>
            </div>
          </div>
          <div className="space-y-2 border-border/70 border-t pt-3 text-muted-foreground text-xs leading-5">
            {sections.map((section) => (
              <p key={section}>{section}</p>
            ))}
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
