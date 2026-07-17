import type { ReactNode } from 'react';

import { cn } from '../lib/utils';

export interface WorkspaceMessageCardProps {
  align: 'start' | 'end';
  attachments?: ReactNode;
  avatar: ReactNode;
  body?: ReactNode;
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
  header,
  retryAction,
  sending = false,
  tone
}: WorkspaceMessageCardProps) {
  const messageStack = (
    <div
      className={cn(
        'flex min-w-0 max-w-[min(72ch,calc(100%-44px))] flex-col',
        align === 'start' ? 'items-start' : 'items-end'
      )}
    >
      {header}
      <div
        className={cn(
          'overflow-wrap-anywhere max-w-full break-words border px-3.5 py-2.5 font-sans text-[15px] leading-[1.55]',
          tone === 'agent'
            ? 'rounded-md border-border bg-secondary text-foreground'
            : 'rounded-[12px_12px_4px_12px] border-foreground bg-foreground text-background',
          sending && 'opacity-70'
        )}
      >
        {body}
        {attachments}
      </div>
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
