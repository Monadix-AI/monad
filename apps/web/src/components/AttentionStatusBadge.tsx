import type { ReactNode } from 'react';

import { Badge, cn } from '@monad/ui';

export type AttentionStatusBadgeState = 'need-approval' | 'need-response' | 'completed';

export function AttentionStatusBadge({ children, state }: { children: ReactNode; state: AttentionStatusBadgeState }) {
  return (
    <Badge
      className={cn(
        'h-5 shrink-0 px-2 py-0 text-[10px]',
        state === 'completed' ? 'border-success/30 bg-success/10 text-success' : 'border-info/30 bg-info/10 text-info'
      )}
      data-attention-status-badge={state}
      variant="outline"
    >
      {children}
    </Badge>
  );
}
