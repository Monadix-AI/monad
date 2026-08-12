import type { ApprovalScope } from '@monad/protocol';
import type { WorkplaceApprovalDecision } from '@monad/sdk-experience';
import type { ApprovalView } from '../../../experience/types.ts';

import { TerminalIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { ComposerApprovalSheet } from '@monad/ui';
import { uiFontFamily as uiFont } from '@monad/ui/components/AgentAvatar';

import { workplaceExperienceT } from '../../../i18n.ts';

type ApprovalStackRoom = {
  approvals: ApprovalView[];
  resolveApproval: (requestId: string, action: WorkplaceApprovalDecision) => void;
};

const decisionForScope: Record<ApprovalScope, WorkplaceApprovalDecision> = {
  once: 'approve-once',
  session: 'approve-session',
  agent: 'approve-once',
  global: 'approve-always'
};

function scopeLabel(scope: ApprovalScope, t: ReturnType<typeof workplaceExperienceT>): string {
  if (scope === 'session') return t('web.workplace.approval.allowSession');
  if (scope === 'global') return t('web.workplace.approval.allowAlways');
  return t('web.workplace.approval.allowOnce');
}

export function ApprovalStack({ room }: { room: ApprovalStackRoom }): React.ReactElement | null {
  const { approvals } = room;
  const top = approvals[0];
  const t = workplaceExperienceT();
  if (!top) return null;

  return (
    <ComposerApprovalSheet
      denyLabel={t('web.workplace.approval.deny')}
      details={
        <code
          className="block min-w-0 overflow-x-auto whitespace-pre-wrap break-words"
          data-selectable="true"
          style={{ fontFamily: uiFont }}
        >
          {top.meta}
        </code>
      }
      moreOptionsLabel={t('web.workplace.approval.moreOptions')}
      onApprove={(scope) => room.resolveApproval(top.id, decisionForScope[scope as ApprovalScope])}
      onDeny={() => room.resolveApproval(top.id, 'reject')}
      options={top.scopes.map((scope) => ({ id: scope, label: scopeLabel(scope, t) }))}
      prompt={t('web.workplace.approval.wantsToRun', { action: top.text })}
      queueLabel={
        approvals.length > 1 ? t('web.workplace.approval.moreWaiting', { count: approvals.length - 1 }) : undefined
      }
      reviewLabel={t('web.workplace.approval.reviewLabel')}
      source={
        <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted">
            <HugeiconsIcon
              aria-hidden="true"
              className="size-3.5"
              icon={TerminalIcon}
            />
          </span>
          <span className="truncate font-medium text-[13px] text-foreground/75">{top.name}</span>
        </div>
      }
    />
  );
}
