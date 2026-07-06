'use client';

import type { ComponentPropsWithoutRef, CSSProperties, ReactElement, ReactNode } from 'react';

import {
  ChevronDownIcon,
  CornerDownLeftIcon,
  MagicWand02Icon,
  Mic01Icon,
  ShieldQuestionMarkIcon,
  SquareIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { forwardRef } from 'react';

import { cn } from '../lib/utils';
import { ChatInputChrome } from './ChatInput';

export type { ComposerContextUsagePanelProps } from './composer/context-usage-panel';

export { ComposerContextUsagePanel } from './composer/context-usage-panel';

export type ComposerSurfaceProps = {
  ariaBusy?: boolean;
  children: ReactNode;
  className?: string;
  leftTools?: ReactNode;
  mentionMenu?: ReactNode;
  mentionPreview?: ReactNode;
  rightTools?: ReactNode;
  voiceLevel?: number;
  voiceSpectrum?: number[];
  voiceState?: 'idle' | 'listening' | 'busy';
};

export function ComposerSurface({
  ariaBusy,
  children,
  className,
  leftTools,
  mentionMenu,
  mentionPreview,
  rightTools,
  voiceLevel = 0,
  voiceSpectrum,
  voiceState = 'idle'
}: ComposerSurfaceProps): ReactElement {
  const voiceActive = voiceState !== 'idle';
  return (
    <ChatInputChrome
      className={cn('shared-composer-panel', voiceActive && 'chat-input-chrome--voice-active', className)}
    >
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
            aria-busy={ariaBusy || undefined}
            className="chat-input-content"
            onBeforeInputCapture={(event) => {
              if (ariaBusy) event.preventDefault();
            }}
            onDropCapture={(event) => {
              if (ariaBusy) event.preventDefault();
            }}
            onKeyDownCapture={(event) => {
              if (ariaBusy) event.preventDefault();
            }}
            onPasteCapture={(event) => {
              if (ariaBusy) event.preventDefault();
            }}
            style={{
              opacity: ariaBusy ? 0.72 : 1,
              pointerEvents: ariaBusy ? 'none' : undefined
            }}
          >
            {children}
            {mentionPreview ? (
              <div
                className="flex flex-wrap items-center gap-1.5 text-[13px]"
                style={{ color: 'var(--muted-foreground)' }}
              >
                {mentionPreview}
              </div>
            ) : null}
          </div>

          <ComposerVoiceSpectrum
            level={voiceLevel}
            spectrum={voiceSpectrum}
            state={voiceState}
          />

          <div
            className="shared-composer-toolbar"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 5,
              padding: 0
            }}
          >
            {leftTools ? (
              <div
                className="shared-composer-tools"
                style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}
              >
                {leftTools}
              </div>
            ) : null}
            {rightTools ? (
              <div
                className="shared-composer-tools shared-composer-tools-right"
                style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto', minWidth: 0 }}
              >
                {rightTools}
              </div>
            ) : null}
          </div>
        </div>
        {mentionMenu}
      </div>
    </ChatInputChrome>
  );
}

function ComposerVoiceSpectrum({
  level,
  spectrum,
  state
}: {
  level: number;
  spectrum?: number[];
  state: 'idle' | 'listening' | 'busy';
}): ReactElement | null {
  if (state === 'idle') return null;
  const normalized = state === 'busy' ? 0.18 : Math.max(0.08, Math.min(1, level));
  const rays = [
    { id: 'a', weight: 0.46 },
    { id: 'b', weight: 0.68 },
    { id: 'c', weight: 0.52 },
    { id: 'd', weight: 0.86 },
    { id: 'e', weight: 0.58 },
    { id: 'f', weight: 1 },
    { id: 'g', weight: 0.64 },
    { id: 'h', weight: 0.92 },
    { id: 'i', weight: 0.5 },
    { id: 'j', weight: 0.76 },
    { id: 'k', weight: 0.56 },
    { id: 'l', weight: 0.82 },
    { id: 'm', weight: 0.44 },
    { id: 'n', weight: 0.72 },
    { id: 'o', weight: 0.54 },
    { id: 'p', weight: 0.88 },
    { id: 'q', weight: 0.62 },
    { id: 'r', weight: 0.96 },
    { id: 's', weight: 0.48 },
    { id: 't', weight: 0.78 }
  ];

  return (
    <div
      aria-hidden="true"
      className={cn('composer-voice-spectrum', state === 'busy' && 'composer-voice-spectrum--busy')}
    >
      <span className="composer-voice-spectrum__core">
        {state === 'busy' ? (
          <svg
            aria-hidden="true"
            className="composer-voice-spectrum__scribe"
            viewBox="0 0 32 32"
          >
            <path
              className="composer-voice-spectrum__scribe-line"
              d="M7 23H19"
            />
            <path
              className="composer-voice-spectrum__scribe-line composer-voice-spectrum__scribe-line--late"
              d="M7 27H24"
            />
            <g className="composer-voice-spectrum__scribe-pen">
              <path d="M12 20L22 10L26 14L16 24L11 25L12 20Z" />
              <path d="M21 11L25 15" />
            </g>
          </svg>
        ) : null}
      </span>
      {rays.map((ray, index) => {
        const angle = (360 / rays.length) * index;
        const band = spectrum && spectrum.length > 0 ? spectrum[index % spectrum.length] : undefined;
        const energy = band == null ? normalized * ray.weight : Math.max(0.04, Math.min(1, band));
        const length = state === 'busy' ? 7 + ((index + 1) % 4) * 2 : 5 + Math.round(energy * 15);
        const opacity = state === 'busy' ? 0.16 : 0.52 + energy * 0.42;
        return (
          <span
            className="composer-voice-spectrum__ray"
            key={ray.id}
            style={{
              animationDelay: `${index * 24}ms`,
              transform: `rotate(${angle}deg)`
            }}
          >
            <span
              className="composer-voice-spectrum__ray-core"
              style={
                {
                  '--composer-voice-ray-length': `${length}px`,
                  opacity
                } as CSSProperties
              }
            />
          </span>
        );
      })}
    </div>
  );
}

export function ComposerSwap({
  ask,
  asking,
  composer
}: {
  ask?: ReactNode;
  asking: boolean;
  composer: ReactNode;
}): ReactElement {
  return (
    <div style={{ padding: '14px 16px 18px', position: 'relative' }}>
      <style>{`
        .monad-ui-composer-host {
          transition:
            opacity 220ms ease,
            transform 260ms cubic-bezier(.2,.9,.24,1);
          transform-origin: bottom center;
        }
        .monad-ui-composer-host.is-asking {
          opacity: 0;
          pointer-events: none;
          transform: translateY(34px) scale(.985);
        }
        .monad-ui-question-slot {
          animation: monadUiQuestionSlotIn 280ms cubic-bezier(.16,1.1,.3,1) both;
          transform-origin: bottom center;
        }
        @keyframes monadUiQuestionSlotIn {
          0% { opacity: 0; transform: translateY(42px) scale(.965); }
          62% { opacity: 1; transform: translateY(-6px) scale(1.006); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
      {ask ? (
        <div
          className="monad-ui-question-slot"
          style={{
            bottom: 18,
            left: 16,
            position: 'absolute',
            right: 16,
            zIndex: 30
          }}
        >
          {ask}
        </div>
      ) : null}
      <div
        aria-hidden={asking}
        className={asking ? 'monad-ui-composer-host is-asking' : 'monad-ui-composer-host'}
      >
        {composer}
      </div>
    </div>
  );
}

export function ComposerSelect({
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
}): ReactElement {
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

export type ComposerAccessMode = 'auto' | 'ask';

export function ComposerAccessSelect({
  ariaLabel,
  askLabel,
  autoLabel,
  mode,
  onChange
}: {
  ariaLabel: string;
  askLabel: string;
  autoLabel: string;
  mode: ComposerAccessMode;
  onChange?: (mode: ComposerAccessMode) => void;
}): ReactElement {
  return (
    <ComposerSelect
      ariaLabel={ariaLabel}
      icon={
        <HugeiconsIcon
          icon={ShieldQuestionMarkIcon}
          size={15}
        />
      }
      onChange={(nextValue) => onChange?.(nextValue as ComposerAccessMode)}
      tone="ink"
      value={mode}
    >
      <option value="auto">{autoLabel}</option>
      <option value="ask">{askLabel}</option>
    </ComposerSelect>
  );
}

export function ComposerModelSelect({
  ariaLabel,
  current,
  onChange,
  options,
  placeholder = 'Model'
}: {
  ariaLabel: string;
  current?: string;
  onChange?: (model: string) => void;
  options: { label: string; value: string }[];
  placeholder?: string;
}): ReactElement {
  const effectiveOptions = options.length ? options : [{ label: placeholder, value: '' }];
  return (
    <ComposerSelect
      ariaLabel={ariaLabel}
      disabled={options.length === 0}
      onChange={onChange}
      tone="ink"
      value={current ?? effectiveOptions[0]?.value ?? ''}
    >
      {effectiveOptions.map((option) => (
        <option
          key={option.value}
          value={option.value}
        >
          {option.label}
        </option>
      ))}
    </ComposerSelect>
  );
}

export type ComposerIconButtonProps = Omit<ComponentPropsWithoutRef<'button'>, 'aria-label'> & {
  active?: boolean;
  ariaDisabled?: boolean;
  ariaLabel: string;
  children: ReactNode;
};

export const ComposerIconButton = forwardRef<HTMLButtonElement, ComposerIconButtonProps>(function ComposerIconButton(
  { active = false, ariaDisabled = false, ariaLabel, children, disabled = false, style, ...props },
  ref
): ReactElement {
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

export type ComposerVoiceButtonProps = Omit<ComposerIconButtonProps, 'active' | 'children'> & {
  state?: 'idle' | 'listening' | 'busy';
};

export const ComposerVoiceButton = forwardRef<HTMLButtonElement, ComposerVoiceButtonProps>(function ComposerVoiceButton(
  { state = 'idle', ...props },
  ref
): ReactElement {
  const active = state === 'listening' || state === 'busy';
  return (
    <ComposerIconButton
      {...props}
      active={active}
      ref={ref}
    >
      {state === 'busy' ? (
        <HugeiconsIcon
          className="animate-spin"
          icon={MagicWand02Icon}
          size={17}
        />
      ) : (
        <span className="relative inline-flex items-center justify-center">
          <HugeiconsIcon
            className={state === 'listening' ? 'text-destructive' : undefined}
            icon={Mic01Icon}
            size={17}
          />
          {state === 'listening' ? (
            <span className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-destructive" />
          ) : null}
        </span>
      )}
    </ComposerIconButton>
  );
});

export type ComposerContextUsageButtonProps = Omit<ComponentPropsWithoutRef<'button'>, 'aria-label'> & {
  ariaLabel: string;
  percent: number;
  title?: string;
  usageAvailable?: boolean;
};

export const ComposerContextUsageButton = forwardRef<HTMLButtonElement, ComposerContextUsageButtonProps>(
  function ComposerContextUsageButton(
    { ariaLabel, percent, style, title, usageAvailable = false, ...props },
    ref
  ): ReactElement {
    const circumference = 2 * Math.PI * 10;
    const clampedPercent = Math.max(0, Math.min(100, Math.round(percent)));
    const dashOffset = circumference * (1 - clampedPercent / 100);

    return (
      <button
        {...props}
        aria-label={ariaLabel}
        className="workplace-action"
        ref={ref}
        style={{
          flex: 'none',
          width: 32,
          height: 32,
          border: 'none',
          borderRadius: '50%',
          background: 'transparent',
          color: 'var(--foreground)',
          cursor: usageAvailable ? 'pointer' : 'default',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          ...style
        }}
        title={title}
        type="button"
      >
        <svg
          aria-hidden="true"
          height="18"
          viewBox="0 0 24 24"
          width="18"
        >
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
    );
  }
);

export function ComposerVoiceUnavailableContent({
  onSettingsClick,
  reason,
  requiresModelSettings,
  settingsLabel,
  setupPrefix,
  setupSuffix
}: {
  onSettingsClick?: () => void;
  reason: string;
  requiresModelSettings?: boolean;
  settingsLabel: string;
  setupPrefix: string;
  setupSuffix: string;
}): ReactElement {
  if (!requiresModelSettings) return <>{reason}</>;
  return (
    <span>
      {setupPrefix}{' '}
      <button
        className="font-medium text-accent-blue underline underline-offset-2"
        onClick={() => onSettingsClick?.()}
        type="button"
      >
        {settingsLabel}
      </button>{' '}
      {setupSuffix}
    </span>
  );
}

export type ComposerSubmitButtonProps = Omit<ComponentPropsWithoutRef<'button'>, 'aria-label'> & {
  ariaLabel: string;
  canSend?: boolean;
  canStop?: boolean;
};

export const ComposerSubmitButton = forwardRef<HTMLButtonElement, ComposerSubmitButtonProps>(
  function ComposerSubmitButton(
    { ariaLabel, canSend = false, canStop = false, disabled = false, onClick, style, ...props },
    ref
  ): ReactElement {
    const enabled = canSend || canStop;
    const interactive = enabled && !disabled;
    return (
      <button
        {...props}
        aria-label={ariaLabel}
        className="workplace-action shared-composer-submit"
        disabled={disabled}
        onClick={onClick}
        ref={ref}
        style={{
          flex: 'none',
          width: 36,
          height: 36,
          border: 'none',
          borderRadius: '50%',
          background: interactive ? 'var(--primary)' : 'rgb(var(--backgroundColor-state-enabled) / 0.48)',
          color: interactive ? 'var(--primary-foreground)' : 'var(--muted-foreground)',
          cursor: interactive ? 'pointer' : 'not-allowed',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          ...style
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
            icon={CornerDownLeftIcon}
            size={17}
          />
        )}
      </button>
    );
  }
);
