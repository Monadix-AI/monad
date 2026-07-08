'use client';

import type { ComposerSendShortcut } from '@monad/ui';
import type React from 'react';
import type { ReactNode } from 'react';

import {
  ComposerAccessSelect,
  ComposerContextUsageButton,
  ComposerContextUsagePanel,
  ComposerEditor,
  ComposerModelSelect,
  ComposerSubmitButton,
  ComposerSurface,
  ComposerVoiceButton,
  ComposerVoiceUnavailableContent
} from '@monad/ui';

import { useT } from '#/components/I18nProvider';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '#/components/ui/hover-card';
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
  sendShortcut?: ComposerSendShortcut;
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
  sendShortcut,
  voiceCancelSignal,
  onVoiceText,
  voice,
  model,
  textareaRef
}: ComposerShellProps): React.ReactElement {
  const t = useT();
  const {
    listening,
    toggleVoice,
    voiceActive,
    voiceBusy,
    voiceDebug,
    voiceDisabledReason,
    voiceLevel,
    voiceModelConfigured,
    voiceSpectrum
  } = useComposerVoice({
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
      ariaBusy={voiceBusy}
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
                          ? 'Transcribing audio'
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
      voiceLevel={voiceLevel}
      voiceSpectrum={voiceSpectrum}
      voiceState={voiceBusy ? 'busy' : listening ? 'listening' : 'idle'}
    >
      {editorSlot ?? (
        <ComposerEditor
          ariaLabel={ariaLabel}
          disabled={disabled || voiceActive}
          editorRef={textareaRef}
          onBlur={onBlur}
          onChange={(nextValue) => onChange?.(nextValue)}
          onKeyDown={(event) => {
            onKeyDown?.(event as unknown as React.KeyboardEvent<HTMLElement>);
            return event.defaultPrevented;
          }}
          onKeyUp={onKeyUp}
          onSubmit={onSubmit}
          placeholder={placeholder}
          sendShortcut={sendShortcut}
          skillToken={composerSkillToken}
          value={value}
        />
      )}
      {voiceDebug ? <VoiceDebugPanel debug={voiceDebug} /> : null}
    </ComposerSurface>
  );
}

function VoiceDebugPanel({
  debug
}: {
  debug: NonNullable<ReturnType<typeof useComposerVoice>['voiceDebug']>;
}): React.ReactElement {
  const rows = [
    ['event', debug.event],
    ['time', debug.timestamp],
    ['mode', debug.mode],
    ['recorder', debug.recorderState ?? 'n/a'],
    ['chunks', String(debug.chunkCount)],
    ['last chunk', debug.lastChunkSize == null ? 'n/a' : `${debug.lastChunkSize} B`],
    ['audio', debug.audioSize == null ? 'n/a' : `${debug.audioSize} B`],
    ['media', debug.mediaType ?? 'n/a'],
    ['transcribe', debug.transcribeStatus],
    ['requestData', debug.requestDataCalled ? 'yes' : 'no'],
    ['discarded', debug.discarded ? 'yes' : 'no'],
    ['detected', debug.voiceDetected ? 'yes' : 'no'],
    ['available', debug.voiceAvailable ? 'yes' : 'no'],
    ['model', debug.voiceModelConfigured ? 'configured' : 'missing'],
    ['reason', debug.voiceDisabledReason ?? 'none'],
    ['error', debug.lastError ?? 'none']
  ];

  return (
    <details className="mx-3 mb-3 rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
      <summary className="cursor-pointer font-medium text-foreground text-xs">Voice debug</summary>
      <dl className="mt-2 grid grid-cols-[88px_1fr] gap-x-3 gap-y-1 font-mono">
        {rows.map(([label, value]) => (
          <div
            className="contents"
            key={label}
          >
            <dt className="text-muted-foreground/70">{label}</dt>
            <dd className="min-w-0 break-all text-foreground/80">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
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
