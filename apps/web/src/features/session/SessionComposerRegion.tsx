import type { SessionComposerModel, SessionTranscriptModel } from './session-route-contract';

import { Cancel01Icon, FileArchiveIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, ComposerSwap } from '@monad/ui';
import { useEffect, useMemo, useRef } from 'react';

import { useT } from '#/components/I18nProvider';
import { CommandMenu } from './CommandMenu';
import { ComposerQueueStack } from './ComposerQueueStack';
import { ComposerShell } from './ComposerShell';
import { activeCommandToken, activeSkillToken } from './command-menu';
import { MessageReplyPreview } from './MessageReplyPreview';
import { SessionApprovalSheet } from './SessionApprovalSheet';
import { SessionClarificationSheet } from './SessionClarificationSheet';
import { useSessionContext } from './session-context';
import { useSessionUiStore } from './session-ui-store';

export function SessionComposerRegion({
  actions,
  model
}: {
  actions: Pick<
    SessionTranscriptModel,
    'onApproval' | 'onClarifyAnswer' | 'pendingApprovals' | 'pendingClarifications'
  >;
  model: SessionComposerModel;
}) {
  const t = useT();
  const { commands, identity, onSkillPreview } = useSessionContext();
  const accessMode = useSessionUiStore((state) => state.accessMode);
  const activeSkill = useSessionUiStore((state) => state.activeSkill);
  const input = useSessionUiStore((state) => state.input);
  const appendVoiceText = useSessionUiStore((state) => state.appendVoiceText);
  const setAccessMode = useSessionUiStore((state) => state.setAccessMode);
  const setActiveSkill = useSessionUiStore((state) => state.setActiveSkill);
  const setComposerInput = useSessionUiStore((state) => state.setComposerInput);
  const editorRef = useRef<HTMLDivElement>(null);
  const archivedSessionIdRef = useRef(identity.isArchived ? identity.currentSessionId : null);
  const activeInputSkill = useMemo(() => activeSkillToken(input, commands, t), [commands, input, t]);
  const activeInputCommand = useMemo(() => activeCommandToken(input, commands), [commands, input]);
  const skillToken = activeInputSkill
    ? {
        label: activeInputSkill.label,
        source: activeInputSkill.sourceLabel,
        icon: activeInputSkill.icon,
        version: activeInputSkill.version,
        raw: activeInputSkill.raw,
        start: activeInputSkill.start,
        end: activeInputSkill.end,
        onClick: () => onSkillPreview(activeInputSkill.id)
      }
    : undefined;
  const commandToken = activeInputCommand
    ? {
        label: activeInputCommand.label,
        raw: activeInputCommand.raw
      }
    : undefined;
  const activeApproval = actions.pendingApprovals[0];
  const activeClarification = actions.pendingClarifications[0];
  const awaitingDecision = !identity.isReadOnly && Boolean(activeApproval || activeClarification);

  useEffect(() => {
    if (identity.isArchived) {
      archivedSessionIdRef.current = identity.currentSessionId;
      return;
    }
    if (archivedSessionIdRef.current !== identity.currentSessionId) return;
    archivedSessionIdRef.current = null;
    const frame = requestAnimationFrame(() => editorRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [identity.currentSessionId, identity.isArchived]);

  if (identity.isArchived) {
    return (
      <div className="session-content-column pointer-events-auto flex min-h-[112px] items-center justify-center py-3">
        <Button
          aria-busy={identity.isUnarchiving}
          className="gap-1.5"
          disabled={identity.isUnarchiving}
          onClick={identity.onUnarchive}
          size="sm"
          variant="secondary"
        >
          <HugeiconsIcon
            className="size-3.5"
            icon={FileArchiveIcon}
          />
          {t('web.sidebar.unarchiveSession')}
        </Button>
      </div>
    );
  }

  return (
    <div className="session-content-column pointer-events-auto pt-2 pb-3">
      {identity.isReadOnly ? (
        <div className="flex items-center justify-center gap-2 py-2 text-muted-foreground text-sm">
          <span className="rounded border bg-muted px-1.5 py-0.5 font-ui text-[10px] uppercase tracking-wide">
            {identity.currentSession?.origin?.client ?? identity.currentSession?.origin?.surface}
          </span>
          <span>{t('web.chat.readOnly')}</span>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <div className="flex items-end gap-2.5">
          <div className="relative flex-1">
            <ComposerSwap
              ask={
                activeApproval ? (
                  <SessionApprovalSheet
                    agentLabel={identity.assistantLabel}
                    approval={activeApproval}
                    key={activeApproval.requestId}
                    onApproval={actions.onApproval}
                    position={1}
                    total={actions.pendingApprovals.length}
                  />
                ) : activeClarification ? (
                  <SessionClarificationSheet
                    assistantLabel={identity.assistantLabel}
                    clarification={activeClarification}
                    key={activeClarification.requestId}
                    onAnswer={(response) => actions.onClarifyAnswer(activeClarification.requestId, response)}
                    total={actions.pendingClarifications.length}
                  />
                ) : null
              }
              asking={awaitingDecision}
              composer={
                <>
                  {model.replyTargetId && !identity.isReadOnly ? (
                    <div className="mb-2 flex min-w-0 items-center gap-2 rounded-md border bg-card/85 p-2">
                      <MessageReplyPreview
                        className="mb-0 flex-1"
                        commands={commands}
                        onOpen={model.onOpenReplyTarget}
                        target={
                          model.replyTarget
                            ? {
                                ...model.replyTarget,
                                label: t('web.chat.replyingTo', {
                                  author:
                                    model.replyTarget.label ??
                                    (model.replyTarget.role === 'user' ? t('web.chat.you') : identity.assistantLabel)
                                })
                              }
                            : null
                        }
                        unavailableLabel={t('web.chat.replyUnavailable')}
                      />
                      <Button
                        aria-label={t('web.chat.cancelReply')}
                        className="shrink-0"
                        onClick={model.onCancelReply}
                        size="icon-sm"
                        title={t('web.chat.cancelReply')}
                        variant="ghost"
                      >
                        <HugeiconsIcon
                          aria-hidden="true"
                          className="size-3.5"
                          icon={Cancel01Icon}
                        />
                      </Button>
                    </div>
                  ) : null}
                  {!identity.isReadOnly ? (
                    <ComposerQueueStack
                      cancelLabel={t('web.cancel')}
                      items={model.messageQueue}
                      onCancel={model.onCancelQueued}
                      onRemove={model.onRemoveQueuedMessage}
                      onSteerNow={model.onSteerQueued}
                      steerNowLabel={t('web.chat.steerNow')}
                    />
                  ) : null}
                  {model.skillMenuOpen && !identity.isReadOnly ? (
                    <CommandMenu
                      activeSkill={activeSkill}
                      items={model.menuItems}
                      loading={model.commandMenuLoading}
                      onApply={model.onCommandItemApply}
                      onHover={setActiveSkill}
                    />
                  ) : null}
                  <ComposerShell
                    access={{
                      mode: identity.isReadOnly ? 'ask' : accessMode,
                      onChange: setAccessMode
                    }}
                    ariaLabel={`Message ${identity.assistantLabel}`}
                    attachmentError={
                      model.attachmentError === 'read'
                        ? t('web.chat.attachmentReadError')
                        : model.attachmentError === 'open'
                          ? t('web.chat.attachmentOpenError')
                          : undefined
                    }
                    attachments={model.attachments}
                    busy={model.isBusy}
                    commandToken={commandToken}
                    contextUsage={model.contextUsage}
                    disabled={identity.isReadOnly}
                    model={model.model}
                    onAttachFiles={model.onAttachFiles}
                    onChange={setComposerInput}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape' && model.replyTargetId && !model.skillMenuOpen) {
                        event.preventDefault();
                        model.onCancelReply();
                        return;
                      }
                      model.onKeyDown(event);
                    }}
                    onOpenAttachment={model.onOpenAttachment}
                    onRemoveAttachment={model.onRemoveAttachment}
                    onStop={model.onStop}
                    onSubmit={model.onSubmit}
                    onVoiceText={appendVoiceText}
                    placeholder={t('web.chat.placeholder')}
                    sendShortcut={model.composerSettings.sendShortcut}
                    skillToken={skillToken}
                    textareaRef={editorRef}
                    value={input}
                    voice={{
                      modelConfigured: model.voiceModelConfigured,
                      onSettingsClick: model.onVoiceSettingsClick,
                      transcribeAudio: model.onVoiceTranscribe
                    }}
                  />
                </>
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}
