import type { AgentCredentialView } from '@monad/protocol';

import { Delete02Icon, Edit02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Badge, Button } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';

export function CredentialCard({
  affectedAgentNames,
  credential,
  deleting,
  onDelete,
  onEdit
}: {
  affectedAgentNames: string[];
  credential: AgentCredentialView;
  deleting: boolean;
  onDelete: () => Promise<void>;
  onEdit: () => void;
}) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  return (
    <article className="rounded-xl border bg-card px-4 py-4 shadow-xs">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-medium text-sm">{credential.label}</h2>
            <Badge variant={credential.configured ? 'secondary' : 'outline'}>
              {credential.configured ? t('web.credentials.configured') : t('web.credentials.notConfigured')}
            </Badge>
          </div>
          {credential.description ? (
            <p className="mt-1 max-w-[72ch] break-words text-muted-foreground text-sm">{credential.description}</p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <code className="rounded-md bg-muted px-2 py-1 font-code">{credential.environmentVariable}</code>
            {credential.allowedHosts.map((host) => (
              <span
                className="rounded-md border px-2 py-1 text-muted-foreground"
                key={host}
              >
                {host}
              </span>
            ))}
            <span className="px-1 py-1 text-muted-foreground">
              {t('web.credentials.agentCount', { count: credential.authorizedAgentIds.length })}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            aria-label={t('web.credentials.edit')}
            onClick={onEdit}
            size="icon"
            variant="ghost"
          >
            <HugeiconsIcon icon={Edit02Icon} />
          </Button>
          <Button
            aria-label={t('web.credentials.delete')}
            className="text-destructive"
            onClick={() => setConfirming(true)}
            size="icon"
            variant="ghost"
          >
            <HugeiconsIcon icon={Delete02Icon} />
          </Button>
        </div>
      </div>
      {confirming ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <p className="text-muted-foreground text-xs">
            {credential.authorizedAgentIds.length
              ? t('web.credentials.deleteUsedWarning', {
                  count: credential.authorizedAgentIds.length,
                  names: affectedAgentNames.join(', ')
                })
              : t('web.credentials.deleteWarning')}
          </p>
          <div className="flex gap-2">
            <Button
              onClick={() => setConfirming(false)}
              size="sm"
              variant="ghost"
            >
              {t('web.common.cancel')}
            </Button>
            <Button
              disabled={deleting}
              onClick={() => void onDelete()}
              size="sm"
              variant="destructive"
            >
              {t('web.credentials.delete')}
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  );
}
