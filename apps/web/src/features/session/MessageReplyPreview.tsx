import type { CommandItem } from '@monad/protocol';
import type { Msg } from './ChatMessage';

import { cn } from '@monad/ui';

import { UserMessageText } from './MessageBody';

type ReplyPreviewTarget = Pick<Msg, 'id' | 'role' | 'text'> & { label?: string };

export function MessageReplyPreview({
  className,
  commands,
  onOpen,
  target,
  unavailableLabel
}: {
  className?: string;
  commands?: CommandItem[];
  onOpen: () => void;
  target: ReplyPreviewTarget | null;
  unavailableLabel: string;
}) {
  return (
    <button
      className={cn(
        'relative mb-2 grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-0.5 overflow-hidden rounded-md border-0 bg-background/35 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-background/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className
      )}
      disabled={!target}
      onClick={onOpen}
      type="button"
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-0.5 bg-accent-blue"
        data-reply-quote-marker=""
      />
      {target ? (
        <>
          <span className="block w-full min-w-0 truncate font-medium text-current/80">{target.label}</span>
          <span className="block max-h-[1lh] w-full min-w-0 truncate whitespace-nowrap text-current/60">
            {target.role === 'user' ? (
              <UserMessageText
                commands={commands}
                compact
                text={target.text}
              />
            ) : (
              target.text
            )}
          </span>
        </>
      ) : (
        <span className="block w-full min-w-0 truncate text-current/60">{unavailableLabel}</span>
      )}
    </button>
  );
}
