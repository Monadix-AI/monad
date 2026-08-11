import type { ReactNode } from 'react';

import { cn } from '../lib/utils';

export interface WorkspaceMessageCardProps {
  align: 'start' | 'end';
  attachments?: ReactNode;
  avatar: ReactNode;
  body?: ReactNode;
  bodyClassName?: string;
  header: ReactNode;
  retryAction?: ReactNode;
  sending?: boolean;
  tone: 'agent' | 'human';
}

export function WorkspaceMessageCard({
  align,
  attachments,
  avatar,
  body,
  bodyClassName,
  header,
  retryAction,
  sending = false,
  tone
}: WorkspaceMessageCardProps) {
  const attachmentStack = attachments ? (
    <div
      className={cn('flex max-w-full flex-col', tone === 'agent' ? 'items-start' : 'mb-2.5 items-end')}
      data-message-attachments={tone}
    >
      {attachments}
    </div>
  ) : null;
  const messageStack = (
    <div
      className={cn(
        'flex min-w-0 max-w-[min(72ch,calc(100%-44px))] flex-col',
        align === 'start' ? 'items-start' : 'items-end'
      )}
    >
      {header}
      {tone === 'human' ? attachmentStack : null}
      <div
        className={cn(
          'overflow-wrap-anywhere max-w-full break-words px-3.5 py-2.5 font-sans text-[15px] leading-[1.55]',
          tone === 'agent'
            ? 'rounded-md bg-(--message-agent-surface) text-foreground'
            : 'rounded-[12px_12px_4px_12px] bg-(--message-human-surface) text-foreground',
          sending && 'opacity-70',
          bodyClassName
        )}
      >
        {body}
      </div>
      {tone === 'agent' ? attachmentStack : null}
    </div>
  );

  return (
    <div
      className={cn(
        'mb-4 flex w-full min-w-0 max-w-full items-start gap-2.5',
        align === 'start' ? 'justify-start' : 'justify-end'
      )}
    >
      {align === 'end' ? retryAction : null}
      {align === 'start' ? avatar : messageStack}
      {align === 'start' ? messageStack : avatar}
    </div>
  );
}

export interface WorkspaceSystemEventCardProps {
  actor?: ReactNode;
  badge?: ReactNode;
  body?: ReactNode;
  fanout?: ReactNode;
  timestamp?: ReactNode;
}

export function WorkspaceSystemEventCard({ actor, badge, body, fanout, timestamp }: WorkspaceSystemEventCardProps) {
  return (
    <div className="mb-3 flex justify-center">
      <div className="inline-grid max-w-[min(620px,100%)] grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-[7px] rounded-xl bg-card px-2 py-1.5 font-sans text-[13px] text-muted-foreground leading-[1.35]">
        {badge}
        {actor}
        {fanout}
        {body}
        {timestamp}
      </div>
    </div>
  );
}
