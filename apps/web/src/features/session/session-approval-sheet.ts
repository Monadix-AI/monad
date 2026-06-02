import type { ApprovalScope } from '@monad/protocol';
import type { PendingApproval } from './session-route-contract';

import { approvalActionScopes } from './approval-display';

export type SessionApprovalChoice = {
  id: `allow:${ApprovalScope}` | 'deny';
  label: string;
  tone?: 'danger';
};

export type SessionApprovalChoiceLabels = Record<ApprovalScope | 'deny', string>;

export type SessionApprovalDecision = {
  allow: boolean;
  scope: ApprovalScope;
  reason?: string;
};

export function sessionApprovalChoices(
  approval: PendingApproval,
  labels: SessionApprovalChoiceLabels
): SessionApprovalChoice[] {
  const scopes = approvalActionScopes(approval.display).filter(
    (scope) => approval.key !== 'host-control' || scope !== 'global'
  );
  return [
    ...scopes.map((scope) => ({
      id: `allow:${scope}` as const,
      label: labels[scope]
    })),
    {
      id: 'deny' as const,
      label: labels.deny,
      tone: 'danger' as const
    }
  ];
}

export function sessionApprovalDecision(choice: SessionApprovalChoice): SessionApprovalDecision {
  if (choice.id === 'deny') {
    return {
      allow: false,
      reason: 'denied by operator',
      scope: 'once'
    };
  }
  return {
    allow: true,
    scope: choice.id.slice('allow:'.length) as ApprovalScope
  };
}
