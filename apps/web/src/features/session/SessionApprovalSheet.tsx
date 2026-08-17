import type { ApprovalScope } from '@monad/protocol';
import type { PendingApproval } from './session-route-contract';

import { ShieldQuestionMarkIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { ComposerApprovalSheet } from '@monad/ui';
import { useMemo } from 'react';

import { useT } from '#/components/I18nProvider';
import { ApprovalDisplayCard } from './ApprovalDisplayCard';
import { type SessionApprovalChoice, sessionApprovalChoices, sessionApprovalDecision } from './session-approval-sheet';

export function SessionApprovalSheet({
  agentLabel,
  approval,
  onApproval,
  position,
  total
}: {
  agentLabel: string;
  approval: PendingApproval;
  onApproval: (approval: PendingApproval, allow: boolean, scope: ApprovalScope, reason?: string) => void;
  position: number;
  total: number;
}) {
  const t = useT();
  const title = approvalTitle(approval, t);
  const choices = useMemo(
    () =>
      sessionApprovalChoices(approval, {
        agent: t('web.chat.approveAgent'),
        deny: t('web.chat.deny'),
        global: t('web.chat.approveAlways'),
        once: t('web.chat.approveOnce'),
        session: t('web.chat.approveSession')
      }),
    [approval, t]
  );
  const allowChoices = choices.filter((choice) => choice.id !== 'deny');
  const denyChoice = choices.find((choice) => choice.id === 'deny');
  const resolve = (choice: SessionApprovalChoice | undefined): void => {
    if (!choice) return;
    const decision = sessionApprovalDecision(choice);
    onApproval(approval, decision.allow, decision.scope, decision.reason);
  };

  return (
    <ComposerApprovalSheet
      denyLabel={t('web.chat.deny')}
      details={<ApprovalSummary approval={approval} />}
      moreOptionsLabel={t('web.workplace.approval.moreOptions')}
      onApprove={(choiceId) => resolve(allowChoices.find((choice) => choice.id === choiceId))}
      onDeny={() => resolve(denyChoice)}
      options={allowChoices.map((choice) => ({ id: choice.id, label: choice.label }))}
      prompt={title}
      queueLabel={total > 1 ? `${position}/${total}` : undefined}
      reviewLabel={title}
      source={
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-warning/12 text-warning">
            <HugeiconsIcon
              aria-hidden="true"
              className="size-3.5"
              icon={ShieldQuestionMarkIcon}
            />
          </span>
          <span className="truncate font-medium text-[13px]">{agentLabel}</span>
          <span className="text-muted-foreground text-xs">{t('web.chat.requestedApproval')}</span>
        </div>
      }
    />
  );
}

function ApprovalSummary({ approval }: { approval: PendingApproval }) {
  const t = useT();
  if (approval.display?.kind === 'resource-approval') {
    return <ApprovalDisplayCard display={approval.display} />;
  }
  if (approval.tool === 'path_access' && approval.key) {
    return (
      <div className="flex items-baseline gap-1.5 text-muted-foreground">
        <span className="shrink-0">{t('web.chat.pathAccessDir')}:</span>
        <code className="min-w-0 break-all font-code">{approval.key}</code>
      </div>
    );
  }
  if (approval.input === undefined) return null;
  return (
    <pre className="max-h-28 overflow-auto rounded-md bg-background p-2 text-muted-foreground text-xs">
      {JSON.stringify(approval.input, null, 2)}
    </pre>
  );
}

function approvalTitle(approval: PendingApproval, t: ReturnType<typeof useT>): string {
  if (approval.display?.kind === 'resource-approval') {
    return approval.display.resource === 'path' ? t('web.chat.pathAccessTitle') : t('web.chat.resourceNetworkAccess');
  }
  if (approval.tool === 'path_access') return t('web.chat.pathAccessTitle');
  return `${t('web.chat.approveTitle')}: ${approval.tool}`;
}
