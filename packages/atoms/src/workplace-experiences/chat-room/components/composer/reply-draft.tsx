import type { Message } from '../../../experience/types.ts';

import { Cancel01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { MentionText } from '@monad/ui/components/MentionText';

export function ReplyDraft({
  cancelLabel,
  onCancel,
  onOpen,
  replyingToLabel,
  target,
  unavailableLabel
}: {
  cancelLabel: string;
  onCancel: () => void;
  onOpen?: () => void;
  replyingToLabel: string;
  target: Message | null;
  unavailableLabel: string;
}): React.ReactElement {
  return (
    <div
      className="mx-3 mb-2 flex min-w-0 items-center gap-2 rounded-md border border-border bg-card/80 px-2.5 py-2"
      style={{ width: 'min(80%, 36rem)' }}
    >
      <button
        className="grid min-w-0 flex-1 gap-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        disabled={!target || !onOpen}
        onClick={onOpen}
        type="button"
      >
        <span className="truncate font-medium text-foreground text-xs">{replyingToLabel}</span>
        {target ? (
          <MentionText
            className="block min-w-0 text-muted-foreground text-xs"
            linkify={false}
            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            text={target.text}
          />
        ) : (
          <span className="truncate text-muted-foreground text-xs">{unavailableLabel}</span>
        )}
      </button>
      <button
        aria-label={cancelLabel}
        className="workplace-action flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onCancel}
        title={cancelLabel}
        type="button"
      >
        <HugeiconsIcon
          aria-hidden="true"
          icon={Cancel01Icon}
          size={15}
        />
      </button>
    </div>
  );
}
