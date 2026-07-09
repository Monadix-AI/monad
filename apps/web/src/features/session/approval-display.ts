import type { ApprovalScope, UIApprovalDisplay } from '@monad/protocol';

const LEGACY_APPROVAL_SCOPES: ApprovalScope[] = ['once', 'session', 'global'];

export function approvalActionScopes(display: UIApprovalDisplay | undefined): ApprovalScope[] {
  const scopes = display?.kind === 'resource-approval' ? display.rememberScopes : undefined;
  const defaultScope = display?.kind === 'resource-approval' ? display.defaultScope : undefined;
  const unique = [...new Set(scopes && scopes.length > 0 ? scopes : LEGACY_APPROVAL_SCOPES)];
  if (!defaultScope || !unique.includes(defaultScope)) return unique;
  return [defaultScope, ...unique.filter((scope) => scope !== defaultScope)];
}
