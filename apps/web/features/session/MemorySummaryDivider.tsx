import type { CompactCommandViewItem } from './chat-view-items';

import { BookOpenTextIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@monad/ui';
import { memo } from 'react';

import { useT } from '@/components/I18nProvider';

export const MemorySummaryDivider = memo(function MemorySummaryDivider({
  item,
  compactStatus,
  pending = false
}: {
  item?: { summary: string };
  compactStatus?: CompactCommandViewItem['status'];
  pending?: boolean;
}) {
  const t = useT();
  const label =
    pending || compactStatus === 'pending'
      ? t('web.chat.compacting')
      : compactStatus === 'noop'
        ? t('web.chat.compactNoop')
        : t('web.chat.compacted');
  return (
    <div className="flex items-center gap-3 self-stretch py-1 text-muted-foreground">
      <div className="h-px flex-1 bg-border/70" />
      <div className="flex items-center gap-2">
        <span className="font-medium text-muted-foreground text-xs">{label}</span>
        {pending ? (
          <div className="flex size-8 items-center justify-center rounded-full border border-border/80 bg-background text-muted-foreground shadow-sm">
            <HugeiconsIcon
              className="size-3.5 animate-pulse"
              icon={BookOpenTextIcon}
            />
          </div>
        ) : item ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label={t('web.chat.memorySummary')}
                className="flex size-8 items-center justify-center rounded-full border border-border/80 bg-background text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                type="button"
              >
                <HugeiconsIcon
                  className="size-3.5"
                  icon={BookOpenTextIcon}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-md whitespace-pre-wrap text-left leading-relaxed">
              <div className="mb-1 font-medium text-popover-foreground">{t('web.chat.memorySummary')}</div>
              <div className="max-h-80 overflow-auto text-muted-foreground">{item.summary}</div>
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className="h-px flex-1 bg-border/70" />
    </div>
  );
});
