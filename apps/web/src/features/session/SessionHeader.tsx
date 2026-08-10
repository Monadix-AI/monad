import {
  Activity01Icon,
  CheckmarkSquare02Icon,
  ExpandParagraphIcon,
  PencilEdit01Icon,
  ReduceParagraphIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button } from '@monad/ui';
import { useEffect, useRef, useState } from 'react';

import { HoverActions } from '#/components/HoverActions';
import { useT } from '#/components/I18nProvider';
import { useWorkspaceShellStore } from '#/lib/workspace-shell-store';
import { useSessionContext } from './session-context';
import { useSessionUiStore } from './session-ui-store';

type SessionHeaderTitleProps = {
  onRename?: (title: string) => void | Promise<void>;
  renameLabel: string;
  title: string;
};

export function SessionHeaderTitle({ onRename, renameLabel, title }: SessionHeaderTitleProps) {
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(false);
  const titleRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!editing) return;
    const element = titleRef.current;
    if (!element) return;
    element.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [editing]);

  const finishEditing = (commit: boolean) => {
    if (!editingRef.current) return;
    editingRef.current = false;
    const nextTitle = titleRef.current?.textContent?.trim() ?? '';
    if (!commit || !nextTitle) {
      if (titleRef.current) titleRef.current.textContent = title;
    }
    setEditing(false);
    if (!commit || !nextTitle || nextTitle === title || !onRename) return;
    // The rename is the only thing that can turn the typed text into the real title: React keeps
    // rendering the unchanged `title` prop, so a rejected mutation must put the old text back itself.
    void Promise.resolve(onRename(nextTitle)).catch(() => {
      if (titleRef.current) titleRef.current.textContent = title;
    });
  };

  return (
    <span className="group inline-grid min-w-0 max-w-full grid-cols-[minmax(0,max-content)_auto] items-center gap-0.5">
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useAriaPropsSupportedByRole: this same title node becomes a labeled contentEditable textbox only while editing so its geometry never shifts. */}
      <span
        aria-label={editing ? renameLabel : undefined}
        className="min-w-0 truncate font-medium text-sm outline-none focus-visible:underline focus-visible:decoration-muted-foreground/50 focus-visible:underline-offset-2"
        contentEditable={editing}
        onBlur={() => finishEditing(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            finishEditing(true);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            finishEditing(false);
          }
        }}
        ref={titleRef}
        role={editing ? 'textbox' : undefined}
        suppressContentEditableWarning
      >
        {title}
      </span>
      {onRename ? (
        <HoverActions className={editing ? 'pointer-events-none invisible' : undefined}>
          <Button
            aria-label={renameLabel}
            className="text-muted-foreground"
            onClick={() => {
              editingRef.current = true;
              setEditing(true);
            }}
            size="icon-sm"
            title={renameLabel}
            variant="ghost"
          >
            <HugeiconsIcon icon={PencilEdit01Icon} />
          </Button>
        </HoverActions>
      ) : null}
    </span>
  );
}

export function SessionHeader() {
  const t = useT();
  const { identity } = useSessionContext();
  const rightPanelOpen = useWorkspaceShellStore((state) => state.rightPanelOpen);
  const rightPanelView = useWorkspaceShellStore((state) => state.rightPanelView);
  const toggleRightPanelView = useWorkspaceShellStore((state) => state.toggleRightPanelView);
  const inspectorOpen = rightPanelOpen && rightPanelView === 'inspector';
  const planOpen = rightPanelOpen && rightPanelView === 'plan';
  const renderMode = useSessionUiStore((state) => state.transcriptRenderMode);
  const setRenderMode = useSessionUiStore((state) => state.setTranscriptRenderMode);

  return (
    <div className="panel-shell-header [.app-main-sidebar-collapsed_&]:!pl-[8.5rem] flex h-[52px] shrink-0 items-center justify-between gap-2.5 border-border/70 border-b px-4 py-2">
      <div className="flex min-w-0 flex-1 flex-col items-start">
        <SessionHeaderTitle
          onRename={identity.onRename}
          renameLabel={t('web.sidebar.renameSession')}
          title={identity.currentSession?.title ?? identity.assistantLabel}
        />
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
            aria-pressed={planOpen}
            className="hidden gap-1.5 lg:inline-flex"
            onClick={() => toggleRightPanelView('plan')}
            size="sm"
            variant={planOpen ? 'secondary' : 'ghost'}
          >
            <HugeiconsIcon
              className="size-3.5"
              icon={CheckmarkSquare02Icon}
            />
            {t('web.plan.toggle')}
          </Button>
          <Button
            aria-pressed={inspectorOpen}
            className="gap-1.5"
            onClick={() => toggleRightPanelView('inspector')}
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
