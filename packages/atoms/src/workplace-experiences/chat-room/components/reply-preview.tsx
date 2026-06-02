import type { Message } from '../../experience/types.ts';

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
      className="mb-1 block w-full min-w-0 border-0 border-current/20 border-l-2 bg-transparent py-0 pr-0 pl-2 text-left text-current/50 text-xs transition-colors hover:text-current/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
      disabled={!target}
      onClick={onOpen}
      type="button"
    >
      {target ? (
        <span className="block truncate">
          {target.authorName}: {target.text}
        </span>
      ) : (
        <span className="block truncate">{unavailableLabel}</span>
      )}
    </button>
  );
}
