'use client';

import { useClearApprovalsMutation, useListApprovalsQuery, useRevokeApprovalMutation } from '@monad/client-rtk';
import { Button } from '@monad/ui';
import { ShieldCheck, Trash2 } from 'lucide-react';

import { useT } from '@/components/I18nProvider';
import { StudioPanel, StudioPanelHeader } from './studio/StudioPanel';

interface Props {
  onClose: () => void;
}

// Authorized-rules panel: lists remembered allow/deny rules (persisted global + agent) and lets the
// user revoke one or clear all so the gate prompts again. Session rules aren't shown here (they're
// scoped to a live session and cleared on its end).
export function ApprovalsSettings(_props: Props) {
  const t = useT();
  const { data: rules = [] } = useListApprovalsQuery(undefined);
  const [revoke, { isLoading: revoking }] = useRevokeApprovalMutation();
  const [clearAll, { isLoading: clearing }] = useClearApprovalsMutation();

  return (
    <StudioPanel>
      <StudioPanelHeader
        icon={<ShieldCheck className="size-4 text-muted-foreground" />}
        title={t('web.settings.approvals')}
      />

      <div className="flex flex-1 flex-col gap-4 px-6 py-6">
        <div className="flex items-center justify-between gap-4">
          <p className="text-muted-foreground text-sm">{t('web.approvals.desc')}</p>
          {rules.length > 0 && (
            <Button
              disabled={clearing}
              onClick={() => void clearAll({})}
              size="sm"
              variant="outline"
            >
              <Trash2 className="size-4" /> {t('web.approvals.clearAll')}
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
                  <code className="truncate font-mono">
                    {r.tool === 'fs_path_access'
                      ? `${t('web.chat.pathAccessTitle')}: ${r.key ?? '?'}`
                      : r.key
                        ? `${r.tool}(${r.key})`
                        : r.tool}
                  </code>
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
      </div>
    </StudioPanel>
  );
}
