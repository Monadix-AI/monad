import { Activity01Icon, ExpandParagraphIcon, ReduceParagraphIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button } from '@monad/ui';

import { useT } from '#/components/I18nProvider';
import { useWorkspaceShellStore } from '#/lib/workspace-shell-store';
import { useSessionContext } from './session-context';
import { useSessionUiStore } from './session-ui-store';

export function SessionHeader() {
  const t = useT();
  const { identity } = useSessionContext();
  const inspectorOpen = useWorkspaceShellStore((state) => state.rightPanelOpen);
  const toggleInspector = useWorkspaceShellStore((state) => state.toggleRightPanel);
  const renderMode = useSessionUiStore((state) => state.transcriptRenderMode);
  const setRenderMode = useSessionUiStore((state) => state.setTranscriptRenderMode);

  return (
    <div className="panel-shell-header [.app-main-sidebar-collapsed_&]:!pl-[8.5rem] flex h-[52px] shrink-0 items-center justify-between gap-2.5 border-border/70 border-b px-4 py-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="truncate font-medium text-sm">{identity.currentSession?.title ?? identity.assistantLabel}</div>
        {identity.onRetryDraftSession ? (
          <div className="text-muted-foreground text-xs">{t('web.chat.draftCreateFailed')}</div>
        ) : null}
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
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            aria-label={renderMode === 'summary' ? t('web.chat.viewModeDetail') : t('web.chat.viewModeSummary')}
            aria-pressed={renderMode === 'summary'}
            className="gap-1.5"
            onClick={() => setRenderMode(renderMode === 'summary' ? 'detail' : 'summary')}
            size="sm"
            title={renderMode === 'summary' ? t('web.chat.viewModeSummary') : t('web.chat.viewModeDetail')}
            variant={renderMode === 'summary' ? 'secondary' : 'ghost'}
          >
            <HugeiconsIcon
              className="size-3.5"
              icon={renderMode === 'summary' ? ExpandParagraphIcon : ReduceParagraphIcon}
            />
            {renderMode === 'summary' ? t('web.chat.viewModeSummaryLabel') : t('web.chat.viewModeDetailLabel')}
          </Button>
          <Button
            aria-pressed={inspectorOpen}
            className="gap-1.5"
            onClick={toggleInspector}
            size="sm"
            variant={inspectorOpen ? 'secondary' : 'ghost'}
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
  );
}
