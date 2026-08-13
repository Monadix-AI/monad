import type { Message } from '../../experience/types.ts';

import { MentionText } from '@monad/ui/components/MentionText';

export function shouldSuppressReplyPreview(
  replyToMessageId: string | undefined,
  previousMessageId: string | undefined
): boolean {
  return !replyToMessageId || replyToMessageId === previousMessageId;
}

export function ReplyPreview({
  onOpen,
  target,
  unavailableLabel
}: {
  onOpen: () => void;
  target: Message | null;
  unavailableLabel: string;
}): React.ReactElement {
  return (
    <button
      className="relative mb-1 block w-full min-w-0 overflow-hidden border-0 bg-transparent py-0 pr-0 pl-2 text-left text-current/50 text-xs transition-colors hover:text-current/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
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
        <span className="block max-h-[1lh] w-full min-w-0 truncate whitespace-nowrap">
          {target.authorName}:{' '}
          <MentionText
            className="whitespace-nowrap break-normal [overflow-wrap:normal]"
            linkify={false}
            text={target.text}
          />
        </span>
      ) : (
        <span className="block w-full min-w-0 truncate">{unavailableLabel}</span>
      )}
    </button>
  );
}
