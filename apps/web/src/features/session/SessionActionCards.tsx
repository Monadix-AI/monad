import type { ApprovalScope } from '@monad/protocol';
import type { PendingApproval } from './session-route-contract';

import {
  ArrowUp01Icon,
  Cancel01Icon,
  CheckIcon,
  HelpCircleIcon,
  ShieldQuestionMarkIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, Textarea } from '@monad/ui';
import { memo, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { ApprovalDisplayCard } from './ApprovalDisplayCard';
import { approvalActionScopes } from './approval-display';

export function ApprovalCard({
  approval,
  onApproval
}: {
  approval: PendingApproval;
  onApproval: (approval: PendingApproval, allow: boolean, scope: ApprovalScope, reason?: string) => void;
}) {
  const t = useT();
  const scopes = approvalActionScopes(approval.display).filter(
    (scope) => approval.key !== 'host-control' || scope !== 'global'
  );

  return (
    <div className="panel-subtle flex max-w-170 flex-col gap-2 self-start border-warning/40 bg-warning/10 px-4 py-4">
      <div className="flex items-center gap-2 font-medium text-sm text-warning">
        <HugeiconsIcon
          className="size-4"
          icon={ShieldQuestionMarkIcon}
        />
        {approval.display?.kind === 'resource-approval' ? (
          approval.display.resource === 'path' ? (
            t('web.chat.pathAccessTitle')
          ) : (
            t('web.chat.resourceNetworkAccess')
          )
        ) : approval.tool === 'path_access' ? (
          t('web.chat.pathAccessTitle')
        ) : (
          <>
            {t('web.chat.approveTitle')}: <code className="font-mono">{approval.tool}</code>
          </>
        )}
      </div>
      {approval.display?.kind === 'resource-approval' ? (
        <ApprovalDisplayCard display={approval.display} />
      ) : approval.tool === 'path_access' && approval.key ? (
        <div className="flex items-baseline gap-1.5 text-muted-foreground text-xs">
          <span className="shrink-0">{t('web.chat.pathAccessDir')}:</span>
          <code className="min-w-0 break-all font-mono">{approval.key}</code>
        </div>
      ) : approval.input !== undefined ? (
        <pre className="max-h-32 overflow-auto rounded-md bg-background/60 p-3 text-muted-foreground text-xs">
          {JSON.stringify(approval.input, null, 2)}
        </pre>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {scopes.map((scope, index) => (
          <Button
            key={scope}
            onClick={() => onApproval(approval, true, scope)}
            size="sm"
            variant={index === 0 ? undefined : 'outline'}
          >
            {index === 0 ? <HugeiconsIcon icon={CheckIcon} /> : null}
            {approvalScopeLabel(scope, t)}
          </Button>
        ))}
        <Button
          onClick={() => onApproval(approval, false, 'once', 'denied by operator')}
          size="sm"
          variant="outline"
        >
          <HugeiconsIcon icon={Cancel01Icon} /> {t('web.chat.deny')}
        </Button>
      </div>
    </div>
  );
}

function approvalScopeLabel(scope: ApprovalScope, t: ReturnType<typeof useT>): string {
  if (scope === 'once') return t('web.chat.approveOnce');
  if (scope === 'session') return t('web.chat.approveSession');
  if (scope === 'global') return t('web.chat.approveAlways');
  return 'This agent';
}

export const ClarifyPrompt = memo(function ClarifyPrompt({
  question,
  options,
  onAnswer
}: {
  question: string;
  options?: string[];
  onAnswer: (answer: string) => void;
}) {
  const t = useT();
  const [value, setValue] = useState('');
  const submit = (answer: string) => {
    const trimmed = answer.trim();
    if (trimmed) onAnswer(trimmed);
  };

  return (
    <div className="flex max-w-170 flex-col gap-2 self-start rounded-lg border border-info/40 bg-info/10 px-3.5 py-3">
      <div className="flex items-center gap-2 font-medium text-info text-sm">
        <HugeiconsIcon
          className="size-4"
          icon={HelpCircleIcon}
        />
        {t('web.chat.clarifyTitle')}
      </div>
      <p className="whitespace-pre-wrap text-foreground text-sm">{question}</p>
      {options && options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {options.map((option) => (
            <Button
              key={option}
              onClick={() => submit(option)}
              size="sm"
              variant="outline"
            >
              {option}
            </Button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          className="min-h-9 flex-1 resize-none"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit(value);
            }
          }}
          placeholder={t('web.chat.clarifyPlaceholder')}
          rows={1}
          value={value}
        />
        <Button
          disabled={!value.trim()}
          onClick={() => submit(value)}
          size="sm"
        >
          <HugeiconsIcon
            className="size-4"
            icon={ArrowUp01Icon}
          />
          {t('web.chat.clarifySend')}
        </Button>
      </div>
    </div>
  );
});
