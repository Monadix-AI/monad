import type { SessionComposerModel, SessionIdentityModel } from './session-route-contract';

import { useMemo } from 'react';

import { useT } from '#/components/I18nProvider';
import { CommandMenu } from './CommandMenu';
import { ComposerQueueStack } from './ComposerQueueStack';
import { ComposerShell } from './ComposerShell';
import { activeCommandToken, activeSkillToken } from './command-menu';
import { SESSION_CONTENT_CLASS } from './session-layout';
import { useSessionUiStore } from './session-ui-store';

export function SessionComposerRegion({
  identity,
  model,
  onSkillPreview
}: {
  identity: SessionIdentityModel;
  model: SessionComposerModel;
  onSkillPreview: (id: string) => void;
}) {
  const t = useT();
  const accessMode = useSessionUiStore((state) => state.accessMode);
  const activeSkill = useSessionUiStore((state) => state.activeSkill);
  const input = useSessionUiStore((state) => state.input);
  const appendVoiceText = useSessionUiStore((state) => state.appendVoiceText);
  const setAccessMode = useSessionUiStore((state) => state.setAccessMode);
  const setActiveSkill = useSessionUiStore((state) => state.setActiveSkill);
  const setComposerInput = useSessionUiStore((state) => state.setComposerInput);
  const activeInputSkill = useMemo(() => activeSkillToken(input, model.commands, t), [input, model.commands, t]);
  const activeInputCommand = useMemo(() => activeCommandToken(input, model.commands), [input, model.commands]);
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

  return (
    <div className={`${SESSION_CONTENT_CLASS} pt-2 pb-3`}>
      {identity.isReadOnly ? (
        <div className="flex items-center justify-center gap-2 py-2 text-muted-foreground text-sm">
          <span className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide">
            {identity.currentSession?.origin?.client ?? identity.currentSession?.origin?.surface}
          </span>
          <span>{t('web.chat.readOnly')}</span>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <div className="flex items-end gap-2.5">
          <div className="relative flex-1">
            {!identity.isReadOnly ? (
              <ComposerQueueStack
                items={model.messageQueue}
                onRemove={model.onRemoveQueuedMessage}
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
              busy={model.isBusy}
              commandToken={commandToken}
              contextUsage={model.contextUsage}
              disabled={identity.isReadOnly}
              model={model.model}
              onChange={setComposerInput}
              onKeyDown={model.onKeyDown}
              onStop={model.onStop}
              onSubmit={model.onSubmit}
              onVoiceText={appendVoiceText}
              placeholder={t('web.chat.placeholder')}
              sendShortcut={model.composerSettings.sendShortcut}
              skillToken={skillToken}
              value={input}
              voice={{
                modelConfigured: model.voiceModelConfigured,
                onSettingsClick: model.onVoiceSettingsClick,
                transcribeAudio: model.onVoiceTranscribe
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
