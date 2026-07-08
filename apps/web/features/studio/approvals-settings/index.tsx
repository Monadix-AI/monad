'use client';

import type { ApprovalRule } from '@monad/protocol';

import { Delete02Icon, Shield01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  approvalRuleSelectors,
  useClearApprovalsMutation,
  useListApprovalsQuery,
  useRevokeApprovalMutation
} from '@monad/client-rtk';
import { Button } from '@monad/ui';
import { useMemo } from 'react';

import { useT } from '#/components/I18nProvider';
import { PanelShell, PanelShellBody } from '#/components/ui/panel-shell';
import { StudioBreadcrumbHeader } from '#/features/studio/StudioBreadcrumbHeader';

interface Props {
  onClose: () => void;
}

type Translate = (key: string) => string;

export function approvalRuleLabel(rule: ApprovalRule, t: Translate): string {
  if (rule.tool === 'path_access') {
    const key = rule.key ?? '?';
    const match = /^(write|cwd|execute):(.+)$/.exec(key);
    return match
      ? `${t('web.chat.pathAccessTitle')} · ${match[1]} · ${match[2]}`
      : `${t('web.chat.pathAccessTitle')} · ${key}`;
  }
  return rule.key ? `${rule.tool}(${rule.key})` : rule.tool;
}

// Authorized-rules panel: lists remembered allow/deny rules (persisted global + agent) and lets the
// user revoke one or clear all so the gate prompts again. Session rules aren't shown here (they're
// scoped to a live session and cleared on its end).
export function ApprovalsSettings(_props: Props) {
  const t = useT();
  const { data: ruleData } = useListApprovalsQuery(undefined);
  const rules = useMemo(
    () => approvalRuleSelectors.selectAll(ruleData?.rules ?? { ids: [], entities: {} }),
    [ruleData]
  );
  const [revoke, { isLoading: revoking }] = useRevokeApprovalMutation();
  const [clearAll, { isLoading: clearing }] = useClearApprovalsMutation();

  return (
    <PanelShell>
      <StudioBreadcrumbHeader
        icon={
          <HugeiconsIcon
            className="size-4 text-muted-foreground"
            icon={Shield01Icon}
          />
        }
        title={t('web.settings.approvals')}
      />

      <PanelShellBody className="flex flex-col gap-4 px-6 py-6">
        <div className="flex items-center justify-between gap-4">
          <p className="text-muted-foreground text-sm">{t('web.approvals.desc')}</p>
          {rules.length > 0 && (
            <Button
              disabled={clearing}
              onClick={() => void clearAll({})}
              size="sm"
              variant="outline"
            >
              <HugeiconsIcon
                className="size-4"
                icon={Delete02Icon}
              />{' '}
              {t('web.approvals.clearAll')}
            </Button>
          )}
        </div>

        {rules.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('web.approvals.empty')}</p>
        ) : (
          <div className="flex flex-col gap-1">
            {rules.map((r) => (
              <div
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                key={r.id}
              >
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  <span className={r.decision === 'deny' ? 'font-medium text-destructive' : 'font-medium text-success'}>
                    {r.decision}
                  </span>
                  <code className="truncate font-mono">{approvalRuleLabel(r, t)}</code>
                  <span className="text-muted-foreground text-xs">
                    {r.scope === 'agent' ? `agent:${r.agentId ?? '?'}` : r.scope}
                  </span>
                </div>
                <Button
                  disabled={revoking}
                  onClick={() => void revoke({ id: r.id })}
                  size="sm"
                  variant="ghost"
                >
                  {t('web.approvals.revoke')}
                </Button>
              </div>
            ))}
          </div>
        )}
      </PanelShellBody>
    </PanelShell>
  );
}
