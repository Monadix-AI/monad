import type { SessionId } from '@monad/protocol';
import type { SessionIdentityModel, SessionInspectorModel } from './session-route-contract';

import { Activity01Icon, ExpandParagraphIcon, GitBranchIcon, ReduceParagraphIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useProvenanceQuery } from '@monad/client-rtk';
import { Button } from '@monad/ui';
import { memo } from 'react';

import { useT } from '#/components/I18nProvider';

export function SessionHeader({
  identity,
  inspector
}: {
  identity: SessionIdentityModel;
  inspector: SessionInspectorModel;
}) {
  const t = useT();

  return (
    <>
      {identity.isDraft ? null : (
        <SessionLineage
          onSelect={identity.onSelectSession}
          sessionId={identity.currentSessionId}
        />
      )}
      <div className="flex items-center justify-between gap-2.5 border-border/70 border-b px-4 py-2">
        <div className="min-w-0">
          <div className="truncate font-medium text-sm">
            {identity.currentSession?.title ?? identity.assistantLabel}
          </div>
          <div className="text-muted-foreground text-xs">
            {identity.onRetryDraftSession ? t('web.chat.draftCreateFailed') : t('web.inspector.sessionRuntime')}
          </div>
        </div>
        {identity.onRetryDraftSession ? (
          <Button
            className="gap-1.5"
            onClick={identity.onRetryDraftSession}
            size="sm"
            variant="secondary"
          >
            {t('web.chat.retry')}
          </Button>
        ) : (
          <div className="flex items-center gap-1.5">
            <Button
              aria-label={
                inspector.renderMode === 'compact' ? t('web.chat.viewModeDetail') : t('web.chat.viewModeCompact')
              }
              aria-pressed={inspector.renderMode === 'compact'}
              className="gap-1.5"
              onClick={() => inspector.onRenderModeChange(inspector.renderMode === 'compact' ? 'detail' : 'compact')}
              size="sm"
              title={inspector.renderMode === 'compact' ? t('web.chat.viewModeCompact') : t('web.chat.viewModeDetail')}
              variant={inspector.renderMode === 'compact' ? 'secondary' : 'ghost'}
            >
              <HugeiconsIcon
                className="size-3.5"
                icon={inspector.renderMode === 'compact' ? ExpandParagraphIcon : ReduceParagraphIcon}
              />
              {inspector.renderMode === 'compact' ? 'Compact' : 'Detail'}
            </Button>
            <Button
              aria-pressed={inspector.open}
              className="gap-1.5"
              onClick={inspector.onToggle}
              size="sm"
              variant={inspector.open ? 'secondary' : 'ghost'}
            >
              <HugeiconsIcon
                className="size-3.5"
                icon={Activity01Icon}
              />
              {t('web.inspector.toggle')}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

const SessionLineage = memo(function SessionLineage({
  sessionId,
  onSelect
}: {
  sessionId: SessionId;
  onSelect: (id: SessionId) => void;
}) {
  const t = useT();
  const { data } = useProvenanceQuery(sessionId);
  const parent = data?.ancestors.at(-1);
  const branches = data?.descendants ?? [];
  if (!parent && branches.length === 0) return null;

  return (
    <div className="flex items-center gap-2 border-b px-4 py-1.5 text-muted-foreground text-xs">
      {parent && (
        <button
          className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-accent-foreground"
          onClick={() => onSelect(parent.id)}
          type="button"
        >
          <HugeiconsIcon
            className="size-3"
            icon={GitBranchIcon}
          />
          <span className="text-muted-foreground/70">{t('web.chat.lineageParent')}</span>
          <span className="max-w-40 truncate font-medium text-foreground">{parent.title}</span>
        </button>
      )}
      {branches.length > 0 && (
        <span className="flex items-center gap-1">
          <span className="text-muted-foreground/40">·</span>
          {t('web.chat.lineageBranches', { count: branches.length })}
        </span>
      )}
    </div>
  );
});
