'use client';

import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from 'react';

import {
  ArrowUp01Icon,
  ChevronDownIcon,
  MagicWand02Icon,
  Mic01Icon,
  ShieldQuestionMarkIcon,
  SquareIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { forwardRef } from 'react';

import { cn } from '../lib/utils';
import { ChatInputChrome } from './ChatInput';

export type ComposerSurfaceProps = {
  ariaBusy?: boolean;
  busyTitle?: string;
  children: ReactNode;
  className?: string;
  leftTools?: ReactNode;
  mentionMenu?: ReactNode;
  mentionPreview?: ReactNode;
  rightTools?: ReactNode;
};

export function ComposerSurface({
  ariaBusy,
  busyTitle,
  children,
  className,
  leftTools,
  mentionMenu,
  mentionPreview,
  rightTools
}: ComposerSurfaceProps): ReactElement {
  return (
    <ChatInputChrome className={cn('shared-composer-panel', className)}>
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
            title={busyTitle}
          >
            {ariaBusy ? null : mentionMenu}
            {children}
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
      </div>
    </ChatInputChrome>
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
          {state === 'listening' ? (
            <span className="absolute inline-flex size-7 animate-ping rounded-full bg-destructive/30" />
          ) : null}
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

export type ComposerContextUsagePanelProps = {
  approximate?: boolean;
  contextUsedLabel: string;
  limit: number;
  percent: number;
  segments?: { category: string; color?: string; label: string; tokens: number }[];
  used: number;
};

export function ComposerContextUsagePanel({
  approximate = false,
  contextUsedLabel,
  limit,
  percent,
  segments,
  used
}: ComposerContextUsagePanelProps): ReactElement {
  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b p-3 text-xs">
        <span>
          {percent}% {contextUsedLabel}
        </span>
        <span className="font-mono text-muted-foreground">
          {formatCompact(used)} / {formatCompact(limit)}
          {approximate ? ' ~' : ''}
        </span>
      </div>
      {segments && segments.length > 0 ? (
        <div className="flex flex-col gap-2 p-3">
          {segments.map((segment) => (
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
    </>
  );
}

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
          background: enabled ? 'var(--foreground)' : 'var(--secondary)',
          color: enabled ? 'var(--background)' : 'var(--muted-foreground)',
          cursor: enabled ? 'pointer' : 'not-allowed',
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
            icon={ArrowUp01Icon}
            size={18}
          />
        )}
      </button>
    );
  }
);

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}
