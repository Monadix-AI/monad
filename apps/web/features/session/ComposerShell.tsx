'use client';

import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import {
  ArrowUp01Icon,
  ChevronDownIcon,
  MagicWand02Icon,
  Mic01Icon,
  ShieldQuestionMarkIcon,
  SquareIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { ChatInputChrome } from '@monad/ui';
import { forwardRef } from 'react';

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
  onVoiceText,
  voice,
  model,
  textareaRef
}: ComposerShellProps): React.ReactElement {
  const t = useT();
  const { listening, toggleVoice, voiceActive, voiceBusy, voiceDisabledReason, voiceModelConfigured } =
    useComposerVoice({
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
    <ChatInputChrome className="shared-composer-panel">
      <div className="chat-input-frame">
        <div
          aria-hidden="true"
          className="chat-input-aurora"
        >
          <div className="chat-input-aurora-root">
            <div className="chat-input-aurora-inner-glow">
              <div className="chat-input-aurora-glow-pulse">
                <div className="chat-input-aurora-edge-mask">
                  <div className="chat-input-aurora-blur-field">
                    <div className="chat-input-aurora-gradient" />
                  </div>
                </div>
              </div>
            </div>
            <div className="chat-input-aurora-border-pulse">
              <div className="chat-input-aurora-border-mask">
                <div className="chat-input-aurora-gradient" />
              </div>
            </div>
          </div>
        </div>
        <div
          className="chat-input-surface composer-live-dense"
          role="presentation"
        >
          <div
            aria-busy={voiceActive || undefined}
            className="chat-input-content"
            onBeforeInputCapture={(event) => {
              if (voiceActive) event.preventDefault();
            }}
            onDropCapture={(event) => {
              if (voiceActive) event.preventDefault();
            }}
            onKeyDownCapture={(event) => {
              if (voiceActive) event.preventDefault();
            }}
            onPasteCapture={(event) => {
              if (voiceActive) event.preventDefault();
            }}
            style={{
              opacity: voiceActive ? 0.72 : 1,
              pointerEvents: voiceActive ? 'none' : undefined
            }}
            title={voiceBusy ? 'Cleaning up transcript' : listening ? 'Recording voice input' : undefined}
          >
            {!voiceActive ? mentionMenu : null}
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
            {mentionPreview ? (
              <div
                className="flex flex-wrap items-center gap-1.5 px-4 pb-1.5 text-[13px]"
                style={{ color: 'var(--muted-foreground)' }}
              >
                {mentionPreview}
              </div>
            ) : null}
          </div>

          <div
            className="shared-composer-toolbar"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 5,
              padding: '0 5px 5px'
            }}
          >
            {showLeftTools ? (
              <div
                className="shared-composer-tools"
                style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}
              >
                {enabledControls.access ? (
                  <ComposerSelect
                    ariaLabel="Permission mode"
                    icon={
                      <HugeiconsIcon
                        icon={ShieldQuestionMarkIcon}
                        size={15}
                      />
                    }
                    onChange={(value) => access.onChange?.(value as 'auto' | 'ask')}
                    tone="ink"
                    value={access.mode}
                  >
                    <option value="auto">{t('web.chat.accessAuto')}</option>
                    <option value="ask">{t('web.chat.accessAsk')}</option>
                  </ComposerSelect>
                ) : null}
              </div>
            ) : null}

            {showRightTools ? (
              <div
                className="shared-composer-tools shared-composer-tools-right"
                style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto', minWidth: 0 }}
              >
                {enabledControls.context ? (
                  <ContextUsageButton
                    percent={budgetPercent}
                    usage={contextUsage}
                  />
                ) : null}
                {enabledControls.model ? (
                  <ComposerSelect
                    ariaLabel="Model"
                    disabled={!model || model.options.length === 0}
                    onChange={(value) => model?.onChange?.(value)}
                    tone="ink"
                    value={model?.current ?? model?.options[0]?.value ?? ''}
                  >
                    {(model?.options.length ? model.options : [{ label: 'Model', value: '' }]).map((option) => (
                      <option
                        key={option.value}
                        value={option.value}
                      >
                        {option.label}
                      </option>
                    ))}
                  </ComposerSelect>
                ) : null}
                {enabledControls.voice ? (
                  <HoverCard
                    closeDelay={80}
                    openDelay={120}
                  >
                    <HoverCardTrigger asChild>
                      <ComposerIconButton
                        active={listening || voiceBusy}
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
                      >
                        {voiceBusy ? (
                          <HugeiconsIcon
                            className="animate-spin"
                            icon={MagicWand02Icon}
                            size={17}
                          />
                        ) : (
                          <span className="relative inline-flex items-center justify-center">
                            {listening ? (
                              <span className="absolute inline-flex size-7 animate-ping rounded-full bg-destructive/30" />
                            ) : null}
                            <HugeiconsIcon
                              className={listening ? 'text-destructive' : undefined}
                              icon={Mic01Icon}
                              size={17}
                            />
                            {listening ? (
                              <span className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-destructive" />
                            ) : null}
                          </span>
                        )}
                      </ComposerIconButton>
                    </HoverCardTrigger>
                    {voiceDisabledReason ? (
                      <HoverCardContent
                        align="end"
                        className="w-64 text-sm leading-relaxed"
                      >
                        {!voiceModelConfigured ? (
                          <span>
                            Voice input requires default and transcription models. Go to{' '}
                            <button
                              className="font-medium text-accent-blue underline underline-offset-2"
                              onClick={() => voice?.onSettingsClick?.()}
                              type="button"
                            >
                              model settings
                            </button>{' '}
                            to set them up.
                          </span>
                        ) : (
                          voiceDisabledReason
                        )}
                      </HoverCardContent>
                    ) : null}
                  </HoverCard>
                ) : null}
                {enabledControls.submit ? (
                  <button
                    aria-label={canStop ? 'Stop' : 'Send message'}
                    className="workplace-action shared-composer-submit"
                    disabled={submitDisabled}
                    onClick={canStop ? onStop : onSubmit}
                    style={{
                      flex: 'none',
                      width: 36,
                      height: 36,
                      border: 'none',
                      borderRadius: '50%',
                      background: canSend || canStop ? 'var(--foreground)' : 'var(--secondary)',
                      color: canSend || canStop ? 'var(--background)' : 'var(--muted-foreground)',
                      cursor: canSend || canStop ? 'pointer' : 'not-allowed',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                    type="button"
                  >
                    {canStop ? (
                      <HugeiconsIcon
                        fill="currentColor"
                        icon={SquareIcon}
                        size={16}
                      />
                    ) : (
                      <HugeiconsIcon
                        icon={ArrowUp01Icon}
                        size={18}
                      />
                    )}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </ChatInputChrome>
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
  const circumference = 2 * Math.PI * 10;
  const dashOffset = circumference * (1 - percent / 100);

  return (
    <HoverCard
      closeDelay={80}
      openDelay={120}
    >
      <HoverCardTrigger asChild>
        <button
          aria-label={t('web.chat.contextUsage')}
          className="workplace-action"
          style={{
            flex: 'none',
            width: 32,
            height: 32,
            border: 'none',
            borderRadius: '50%',
            background: 'transparent',
            color: 'var(--foreground)',
            cursor: usage ? 'pointer' : 'default',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
          type="button"
        >
          <svg
            height="18"
            role="img"
            viewBox="0 0 24 24"
            width="18"
          >
            <title>{t('web.chat.contextUsage')}</title>
            <circle
              cx="12"
              cy="12"
              fill="none"
              opacity="0.25"
              r="10"
              stroke="currentColor"
              strokeWidth="2"
            />
            <circle
              cx="12"
              cy="12"
              fill="none"
              opacity="0.78"
              r="10"
              stroke="currentColor"
              strokeDasharray={`${circumference} ${circumference}`}
              strokeDashoffset={dashOffset}
              strokeLinecap="round"
              strokeWidth="2"
              style={{ transform: 'rotate(-90deg)', transformOrigin: 'center' }}
            />
          </svg>
        </button>
      </HoverCardTrigger>
      {usage ? (
        <HoverCardContent
          align="end"
          className="w-72 p-0"
        >
          <div className="flex items-center justify-between gap-3 border-b p-3 text-xs">
            <span>{percent}% context used</span>
            <span className="font-mono text-muted-foreground">
              {formatCompact(usage.used)} / {formatCompact(usage.limit)}
              {usage.approximate ? ' ~' : ''}
            </span>
          </div>
          {usage.segments && usage.segments.length > 0 ? (
            <div className="flex flex-col gap-2 p-3">
              {usage.segments.map((segment) => (
                <div
                  className="flex items-center justify-between gap-4 text-xs"
                  key={`${segment.category}-${segment.label}`}
                >
                  <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                    <span
                      className="inline-block size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: segment.color ?? 'hsl(215 16% 47% / 0.65)' }}
                    />
                    <span className="truncate">{segment.label}</span>
                  </span>
                  <span className="shrink-0 font-mono tabular-nums">{segment.tokens.toLocaleString()}</span>
                </div>
              ))}
            </div>
          ) : null}
        </HoverCardContent>
      ) : null}
    </HoverCard>
  );
}

function ComposerSelect({
  ariaLabel,
  children,
  disabled = false,
  icon,
  onChange,
  tone = 'accent',
  value
}: {
  ariaLabel: string;
  children: ReactNode;
  disabled?: boolean;
  icon?: ReactNode;
  onChange?: (value: string) => void;
  tone?: 'accent' | 'ink';
  value: string;
}): React.ReactElement {
  return (
    <label
      className="workplace-action shared-composer-pill"
      style={{
        flex: 'none',
        minHeight: 32,
        border: 'none',
        borderRadius: 999,
        background: 'var(--shared-composer-control-bg, transparent)',
        color: disabled ? 'var(--muted-foreground)' : tone === 'ink' ? 'var(--foreground)' : 'var(--accent-blue)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '0 var(--shared-composer-pill-x, 7px)',
        fontFamily: 'var(--font-sans), ui-sans-serif, system-ui, sans-serif',
        fontSize: 'var(--shared-composer-font-size, 14px)',
        fontWeight: 600,
        whiteSpace: 'nowrap',
        opacity: disabled ? 0.62 : 1
      }}
    >
      {icon}
      <select
        aria-label={ariaLabel}
        disabled={disabled}
        onChange={(event) => onChange?.(event.currentTarget.value)}
        style={{
          appearance: 'none',
          border: 'none',
          background: 'transparent',
          color: 'inherit',
          cursor: disabled ? 'not-allowed' : 'pointer',
          font: 'inherit',
          outline: 'none'
        }}
        value={value}
      >
        {children}
      </select>
      <HugeiconsIcon
        aria-hidden
        icon={ChevronDownIcon}
        size={14}
      />
    </label>
  );
}

type ComposerIconButtonProps = Omit<ComponentPropsWithoutRef<'button'>, 'aria-label'> & {
  active?: boolean;
  ariaDisabled?: boolean;
  ariaLabel: string;
  children: ReactNode;
};

const ComposerIconButton = forwardRef<HTMLButtonElement, ComposerIconButtonProps>(function ComposerIconButton(
  { active = false, ariaDisabled = false, ariaLabel, children, disabled = false, style, ...props },
  ref
): React.ReactElement {
  return (
    <button
      {...props}
      aria-disabled={ariaDisabled || disabled}
      aria-label={ariaLabel}
      className="workplace-action"
      disabled={disabled}
      ref={ref}
      style={{
        flex: 'none',
        width: 34,
        height: 34,
        border: 'none',
        borderRadius: '50%',
        background: active ? 'var(--accent-blue-soft)' : 'var(--shared-composer-control-bg, transparent)',
        color: active ? 'var(--accent-blue)' : 'var(--muted-foreground)',
        cursor: disabled || ariaDisabled ? 'not-allowed' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled || ariaDisabled ? 0.48 : 1,
        ...style
      }}
      type="button"
    >
      {children}
    </button>
  );
});

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}
