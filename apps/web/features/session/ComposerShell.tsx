'use client';

import type { ReactNode } from 'react';

import {
  ComposerAccessSelect,
  ComposerContextUsageButton,
  ComposerContextUsagePanel,
  ComposerModelSelect,
  ComposerSubmitButton,
  ComposerSurface,
  ComposerVoiceButton,
  ComposerVoiceUnavailableContent
} from '@monad/ui';

import { useT } from '@/components/I18nProvider';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { LexicalComposerInput } from './ComposerLexicalInput';
import { useComposerVoice } from './use-composer-voice';

type ComposerShellProps = {
  access?: {
    mode: 'auto' | 'ask';
    onChange?: (mode: 'auto' | 'ask') => void;
  };
  ariaLabel: string;
  value: string;
  placeholder: string;
  busy?: boolean;
  contextUsage?: {
    approximate?: boolean;
    limit: number;
    segments?: { category: string; color?: string; label: string; tokens: number }[];
    used: number;
  };
  controls?: Partial<Record<'access' | 'context' | 'model' | 'submit' | 'voice', boolean>>;
  disabled?: boolean;
  editorSlot?: ReactNode;
  mentionMenu?: ReactNode;
  skillToken?: {
    label: string;
    source?: string;
    icon?: string;
    version?: string;
    raw: string;
    start: number;
    end: number;
    onClick: () => void;
  };
  mentionPreview?: ReactNode;
  onBlur?: React.FocusEventHandler<HTMLElement>;
  onChange?: (value: string) => void;
  onKeyDown?: React.KeyboardEventHandler<HTMLElement>;
  onKeyUp?: React.KeyboardEventHandler<HTMLElement>;
  onStop?: () => void;
  onSubmit: () => void;
  voiceCancelSignal?: number;
  onVoiceText?: (text: string) => void;
  voice?: {
    modelConfigured?: boolean;
    onSettingsClick?: () => void;
    transcribeAudio?: (audio: Blob) => Promise<string>;
  };
  model?: {
    current?: string;
    onChange?: (model: string) => void;
    options: { label: string; value: string }[];
  };
  textareaRef?: React.Ref<HTMLDivElement>;
};

export function ComposerShell({
  access = { mode: 'auto' },
  ariaLabel,
  value,
  placeholder,
  busy = false,
  contextUsage,
  controls,
  disabled = false,
  editorSlot,
  mentionMenu,
  skillToken,
  mentionPreview,
  onBlur,
  onChange,
  onKeyDown,
  onKeyUp,
  onStop,
  onSubmit,
  voiceCancelSignal,
  onVoiceText,
  voice,
  model,
  textareaRef
}: ComposerShellProps): React.ReactElement {
  const t = useT();
  const { listening, toggleVoice, voiceActive, voiceBusy, voiceDisabledReason, voiceModelConfigured } =
    useComposerVoice({
      cancelSignal: voiceCancelSignal,
      onVoiceText,
      voice
    });
  const canSend = value.trim().length > 0 && !disabled && !voiceActive;
  const canStop = busy && onStop;
  const submitDisabled = !canSend && !canStop;
  const budgetPercent = contextUsage
    ? Math.min(100, Math.round((contextUsage.used / Math.max(1, contextUsage.limit)) * 100))
    : 0;
  const composerSkillToken = skillToken
    ? {
        id: skillToken.raw.startsWith('/') ? skillToken.raw.slice(1) : skillToken.raw,
        label: skillToken.label,
        source: skillToken.source,
        icon: skillToken.icon,
        version: skillToken.version,
        raw: skillToken.raw,
        onClick: skillToken.onClick
      }
    : undefined;
  const enabledControls = {
    access: controls?.access ?? true,
    context: controls?.context ?? true,
    model: controls?.model ?? true,
    submit: controls?.submit ?? true,
    voice: controls?.voice ?? true
  };
  const showLeftTools = enabledControls.access;
  const showRightTools =
    enabledControls.context || enabledControls.model || enabledControls.voice || enabledControls.submit;

  return (
    <ComposerSurface
      ariaBusy={voiceActive}
      busyTitle={voiceBusy ? 'Cleaning up transcript' : listening ? 'Recording voice input' : undefined}
      leftTools={
        showLeftTools && enabledControls.access ? (
          <ComposerAccessSelect
            ariaLabel="Permission mode"
            askLabel={t('web.chat.accessAsk')}
            autoLabel={t('web.chat.accessAuto')}
            mode={access.mode}
            onChange={access.onChange}
          />
        ) : null
      }
      mentionMenu={mentionMenu}
      mentionPreview={mentionPreview}
      rightTools={
        showRightTools ? (
          <>
            {enabledControls.context ? (
              <ContextUsageButton
                percent={budgetPercent}
                usage={contextUsage}
              />
            ) : null}
            {enabledControls.model ? (
              <ComposerModelSelect
                ariaLabel="Model"
                current={model?.current}
                onChange={model?.onChange}
                options={model?.options ?? []}
              />
            ) : null}
            {enabledControls.voice ? (
              <HoverCard
                closeDelay={80}
                openDelay={120}
              >
                <HoverCardTrigger asChild>
                  <ComposerVoiceButton
                    ariaDisabled={Boolean(voiceDisabledReason && !listening && !voiceBusy)}
                    ariaLabel={
                      listening
                        ? 'Recording voice input'
                        : voiceBusy
                          ? 'Cleaning up transcript'
                          : voiceDisabledReason
                            ? voiceDisabledReason
                            : 'Voice input'
                    }
                    disabled={!onVoiceText}
                    onClick={() => void toggleVoice()}
                    state={voiceBusy ? 'busy' : listening ? 'listening' : 'idle'}
                  />
                </HoverCardTrigger>
                {voiceDisabledReason ? (
                  <HoverCardContent
                    align="end"
                    className="w-64 text-sm leading-relaxed"
                  >
                    <ComposerVoiceUnavailableContent
                      onSettingsClick={voice?.onSettingsClick}
                      reason={voiceDisabledReason}
                      requiresModelSettings={!voiceModelConfigured}
                      settingsLabel="model settings"
                      setupPrefix="Voice input requires default and transcription models. Go to"
                      setupSuffix="to set them up."
                    />
                  </HoverCardContent>
                ) : null}
              </HoverCard>
            ) : null}
            {enabledControls.submit ? (
              <ComposerSubmitButton
                ariaLabel={canStop ? 'Stop' : 'Send message'}
                canSend={canSend}
                canStop={Boolean(canStop)}
                disabled={submitDisabled}
                onClick={canStop ? onStop : onSubmit}
              />
            ) : null}
          </>
        ) : null
      }
    >
      {editorSlot ?? (
        <LexicalComposerInput
          ariaLabel={ariaLabel}
          disabled={disabled || voiceActive}
          editorRef={textareaRef}
          onBlur={onBlur}
          onChange={(nextValue) => onChange?.(nextValue)}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          placeholder={placeholder}
          skillToken={composerSkillToken}
          value={value}
        />
      )}
    </ComposerSurface>
  );
}

function ContextUsageButton({
  percent,
  usage
}: {
  percent: number;
  usage?: {
    approximate?: boolean;
    limit: number;
    segments?: { category: string; color?: string; label: string; tokens: number }[];
    used: number;
  };
}): React.ReactElement {
  const t = useT();

  return (
    <HoverCard
      closeDelay={80}
      openDelay={120}
    >
      <HoverCardTrigger asChild>
        <ComposerContextUsageButton
          ariaLabel={t('web.chat.contextUsage')}
          percent={percent}
          title={t('web.chat.contextUsage')}
          usageAvailable={Boolean(usage)}
        />
      </HoverCardTrigger>
      {usage ? (
        <HoverCardContent
          align="end"
          className="w-72 p-0"
        >
          <ComposerContextUsagePanel
            approximate={usage.approximate}
            contextUsedLabel="context used"
            limit={usage.limit}
            percent={percent}
            segments={usage.segments}
            used={usage.used}
          />
        </HoverCardContent>
      ) : null}
    </HoverCard>
  );
}
