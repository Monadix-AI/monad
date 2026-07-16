import { Cancel01Icon, CornerDownLeftIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

import { queuedCardsForDisplay } from '#/lib/composer-settings';

export function ComposerQueueStack({
  className,
  cancelLabel,
  items,
  onCancel,
  onRemove,
  onSteerNow,
  steerNowLabel
}: {
  className?: string;
  cancelLabel: string;
  items: string[];
  onCancel: () => void;
  onRemove: (index: number) => void;
  onSteerNow: () => void;
  steerNowLabel: string;
}) {
  const stackedCards = queuedCardsForDisplay(items);
  const expandedCards = items.map((text, queueIndex) => ({ queueIndex, text })).reverse();
  if (!stackedCards.length) return null;
  return (
    <div
      className={
        className ?? 'group pointer-events-none absolute right-3 bottom-full z-20 mb-1 h-20 w-72 bg-transparent'
      }
      data-slot="composer-queue-stack"
    >
      <div className="absolute right-0 bottom-5 grid w-full bg-transparent transition-opacity group-hover:invisible group-hover:opacity-0">
        {stackedCards.map((card) => (
          <div
            className="pointer-events-auto col-start-1 row-start-1 w-full self-end rounded-md border bg-popover px-3 py-2 pr-7 text-popover-foreground text-xs shadow-lg transition-transform"
            data-slot="composer-queue-stack-card"
            key={`${card.queueIndex}:${card.text}`}
            style={{
              opacity: 1 - card.displayIndex * 0.14,
              transform: `translateY(${-card.displayIndex * 8}px) scale(${1 - card.displayIndex * 0.045})`,
              transformOrigin: 'bottom center',
              zIndex: 20 - card.displayIndex
            }}
          >
            <p className="line-clamp-5 min-w-0 break-words leading-5">{card.text || 'Attachment follow-up'}</p>
            <RemoveQueuedMessageButton
              index={card.queueIndex}
              onRemove={onRemove}
            />
          </div>
        ))}
      </div>
      <div
        className="pointer-events-auto invisible absolute right-0 bottom-5 flex max-h-60 w-full flex-col gap-1 overflow-y-auto overflow-x-hidden overscroll-contain bg-transparent opacity-0 [scrollbar-width:none] group-hover:visible group-hover:opacity-100 [&::-webkit-scrollbar]:hidden"
        data-slot="composer-queue-expanded-list"
      >
        {expandedCards.map((card) => (
          <div
            className="relative w-full shrink-0 rounded-md border bg-popover px-3 py-2 pr-7 text-popover-foreground text-xs"
            data-slot="composer-queue-expanded-card"
            key={`${card.queueIndex}:${card.text}`}
          >
            <p className="line-clamp-5 min-w-0 break-words leading-5">{card.text || 'Attachment follow-up'}</p>
            <RemoveQueuedMessageButton
              index={card.queueIndex}
              onRemove={onRemove}
            />
          </div>
        ))}
      </div>
      <div className="pointer-events-auto absolute right-0 bottom-0 flex items-center gap-2 text-xs">
        <button
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
          onClick={onSteerNow}
          type="button"
        >
          <HugeiconsIcon
            className="size-3.5"
            icon={CornerDownLeftIcon}
          />
          {steerNowLabel}
        </button>
        <button
          className="text-muted-foreground hover:text-foreground"
          onClick={onCancel}
          type="button"
        >
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}

function RemoveQueuedMessageButton({ index, onRemove }: { index: number; onRemove: (index: number) => void }) {
  return (
    <button
      aria-label="Remove queued follow-up"
      className="absolute top-1/2 right-1 grid size-5 -translate-y-1/2 place-items-center rounded-full border bg-background text-muted-foreground shadow-sm hover:bg-accent hover:text-accent-foreground"
      onClick={() => onRemove(index)}
      title="Remove queued follow-up"
      type="button"
    >
      <HugeiconsIcon
        className="size-3"
        icon={Cancel01Icon}
      />
    </button>
  );
}
