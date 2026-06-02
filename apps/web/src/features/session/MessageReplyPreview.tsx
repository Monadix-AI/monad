import type { Msg } from './ChatMessage';

import { cn } from '@monad/ui';

type ReplyPreviewTarget = Pick<Msg, 'id' | 'role' | 'text'> & { label?: string };

export function MessageReplyPreview({
  className,
  onOpen,
  target,
  unavailableLabel
}: {
  className?: string;
  onOpen: () => void;
  target: ReplyPreviewTarget | null;
  unavailableLabel: string;
}) {
  return (
    <button
      className={cn(
        'mb-2 grid w-full min-w-0 gap-0.5 rounded-md border-l-2 border-l-accent-blue bg-background/35 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-background/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className
      )}
      disabled={!target}
      onClick={onOpen}
      type="button"
    >
      {target ? (
        <>
          <span className="truncate font-medium text-current/80">{target.label}</span>
          <span className="truncate text-current/60">{target.text}</span>
        </>
      ) : (
        <span className="truncate text-current/60">{unavailableLabel}</span>
      )}
    </button>
  );
}
