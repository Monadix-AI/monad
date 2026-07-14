import { Cancel01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

import { queuedCardsForDisplay } from '#/lib/composer-settings';

export function ComposerQueueStack({
  className,
  items,
  onRemove
}: {
  className?: string;
  items: string[];
  onRemove: (index: number) => void;
}) {
  const cards = queuedCardsForDisplay(items);
  if (!cards.length) return null;
  return (
    <div className={className ?? 'pointer-events-none absolute right-3 bottom-full z-20 mb-2 h-14 w-72'}>
      {cards.map((card) => (
        <div
          className="pointer-events-auto absolute right-0 max-w-full rounded-md border bg-popover px-3 py-2 pr-5 text-popover-foreground text-xs shadow-lg"
          key={`${card.queueIndex}:${card.text}`}
          style={{
            opacity: card.displayIndex === 0 ? 1 : 0.86,
            top: card.displayIndex * -10,
            transform: card.displayIndex === 0 ? 'none' : 'translateY(-2px) scale(0.94)',
            transformOrigin: 'top right',
            width: card.displayIndex === 0 ? 288 : 270,
            zIndex: 20 - card.displayIndex
          }}
        >
          <p className="line-clamp-2 min-w-0 break-words leading-5">{card.text || 'Attachment follow-up'}</p>
          <button
            aria-label="Remove queued follow-up"
            className="absolute top-1/2 -right-2 grid size-5 -translate-y-1/2 place-items-center rounded-full border bg-background text-muted-foreground shadow-sm hover:bg-accent hover:text-accent-foreground"
            onClick={() => onRemove(card.queueIndex)}
            title="Remove queued follow-up"
            type="button"
          >
            <HugeiconsIcon
              className="size-3"
              icon={Cancel01Icon}
            />
          </button>
        </div>
      ))}
    </div>
  );
}
