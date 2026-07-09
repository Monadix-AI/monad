'use client';

import type { UIApprovalDisplay } from '@monad/protocol';

export function ApprovalDisplayCard({ display }: { display?: UIApprovalDisplay }) {
  if (display?.kind !== 'resource-approval') return null;
  return (
    <div className="rounded-md border border-amber-500/35 bg-amber-500/10 p-3 text-xs">
      <div className="font-medium text-foreground">
        {display.resource === 'network' ? 'Network access' : 'File access'}
        {display.operation ? <span className="text-muted-foreground"> · {display.operation}</span> : null}
      </div>
      {display.subject ? <div className="mt-1 break-all font-mono text-muted-foreground">{display.subject}</div> : null}
      {display.defaultScope ? <div className="mt-2 text-muted-foreground">Default: {display.defaultScope}</div> : null}
    </div>
  );
}
