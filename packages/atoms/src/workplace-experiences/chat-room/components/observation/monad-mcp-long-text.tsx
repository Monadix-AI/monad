'use client';

import { ArrowDown01Icon, ArrowUp01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { cn } from '@monad/ui';
import { MentionText } from '@monad/ui/components/MentionText';
import { useId } from 'react';

import { workplaceExperienceT } from '../../../i18n.ts';
import { useObservationDisclosure } from './disclosure.tsx';

const COLLAPSED_CHARACTER_LIMIT = 480;
const COLLAPSED_LINE_LIMIT = 8;

export function monadMcpTextNeedsCollapse(text: string): boolean {
  return text.length > COLLAPSED_CHARACTER_LIMIT || text.split('\n').length > COLLAPSED_LINE_LIMIT;
}

export function MonadMcpLongText({
  className,
  dataSlot = 'monad-mcp-long-text',
  disclosureKey,
  text
}: {
  className?: string;
  dataSlot?: string;
  disclosureKey: string;
  text: string;
}) {
  const t = workplaceExperienceT();
  const contentId = useId();
  const collapsible = monadMcpTextNeedsCollapse(text);
  const [expanded, setExpanded] = useObservationDisclosure(`long-text/${disclosureKey}`);
  const collapsed = collapsible && !expanded;

  return (
    <div
      className={cn('min-w-0', className)}
      data-collapsed={collapsed}
      data-long-content="true"
      data-slot={dataSlot}
    >
      <div
        className={cn(
          'wrap-anywhere whitespace-pre-wrap text-foreground leading-5',
          collapsed &&
            'max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,#000_calc(100%-2.5rem),transparent_100%)]'
        )}
        id={contentId}
      >
        <MentionText text={text} />
      </div>
      {collapsible ? (
        <button
          aria-controls={contentId}
          aria-expanded={expanded}
          className="mt-1.5 inline-flex min-h-7 items-center gap-1 rounded-md px-1.5 font-medium text-muted-foreground text-xs transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => setExpanded(!expanded)}
          type="button"
        >
          {expanded ? t('web.workplace.monadMcp.longContent.collapse') : t('web.workplace.monadMcp.longContent.expand')}
          <HugeiconsIcon
            aria-hidden="true"
            icon={expanded ? ArrowUp01Icon : ArrowDown01Icon}
            size={14}
            strokeWidth={1.8}
          />
        </button>
      ) : null}
    </div>
  );
}
