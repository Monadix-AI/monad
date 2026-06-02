import type { ObservationSessionUsageMeter } from './session-usage-meter.ts';

import { workspaceMono as mono, workspaceSans as sans } from '@monad/ui/components/AgentAvatar';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { workplaceExperienceT } from '../../../i18n.ts';

const RING_RADIUS = 9;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const POPOVER_EDGE_GAP = 14;
const POPOVER_TRIGGER_GAP = 8;
const POPOVER_WIDTH = 276;

function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, notation: 'compact' }).format(value);
}

function UsageRow({
  emphasis = false,
  label,
  value
}: {
  emphasis?: boolean;
  label: string;
  value: number;
}): React.ReactElement {
  return (
    <div
      style={{
        alignItems: 'center',
        borderTop: emphasis ? '1px solid color-mix(in srgb, var(--border, #e5e7eb) 72%, transparent)' : undefined,
        display: 'flex',
        fontSize: 12,
        gap: 12,
        justifyContent: 'space-between',
        marginTop: emphasis ? 2 : undefined,
        paddingTop: emphasis ? 10 : undefined
      }}
    >
      <span
        style={{
          color: emphasis ? 'var(--foreground, #111827)' : 'var(--muted-foreground, #6b7280)',
          fontWeight: emphasis ? 650 : 400
        }}
      >
        {label}
      </span>
      <span
        style={{
          color: 'var(--foreground, #111827)',
          fontFamily: `${mono}, ui-monospace, monospace`,
          fontVariantNumeric: 'tabular-nums',
          fontWeight: emphasis ? 650 : 400
        }}
      >
        {value.toLocaleString()}
      </span>
    </div>
  );
}

export function ObservationSessionUsageControl({ meter }: { meter: ObservationSessionUsageMeter }): React.ReactElement {
  const t = workplaceExperienceT();
  const [open, setOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState({ left: 0, top: 0 });
  const rootRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const trigger = rootRef.current?.getBoundingClientRect();
      if (!trigger) return;
      const width = Math.min(POPOVER_WIDTH, window.innerWidth - POPOVER_EDGE_GAP * 2);
      setPopoverPosition({
        left: Math.min(Math.max(trigger.left, POPOVER_EDGE_GAP), window.innerWidth - POPOVER_EDGE_GAP - width),
        top: trigger.bottom + POPOVER_TRIGGER_GAP
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    return () => window.removeEventListener('resize', updatePosition);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div
      data-observation-session-usage=""
      ref={rootRef}
      style={{ flex: 'none', position: 'relative' }}
    >
      {open ? (
        <aside
          aria-label={t('web.workplace.sessionUsage')}
          data-observation-session-usage-details=""
          role="dialog"
          style={{
            background: 'var(--popover, var(--background, #fff))',
            border: '1px solid color-mix(in srgb, var(--border, #e5e7eb) 82%, transparent)',
            borderRadius: 14,
            boxShadow: '0 14px 32px color-mix(in srgb, black 16%, transparent)',
            boxSizing: 'border-box',
            fontFamily: `${sans}, ui-sans-serif, system-ui, sans-serif`,
            padding: 14,
            pointerEvents: 'auto',
            position: 'fixed',
            left: popoverPosition.left,
            top: popoverPosition.top,
            width: 'min(276px, calc(100vw - 28px))',
            zIndex: 8
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div
              style={{
                alignItems: 'baseline',
                display: 'flex',
                gap: 12,
                justifyContent: 'space-between'
              }}
            >
              <span style={{ color: 'var(--foreground, #111827)', fontSize: 13, fontWeight: 650 }}>
                {t('web.workplace.contextWindow')}
              </span>
              <span
                style={{
                  color: 'var(--muted-foreground, #6b7280)',
                  fontFamily: `${mono}, ui-monospace, monospace`,
                  fontSize: 12,
                  fontVariantNumeric: 'tabular-nums'
                }}
              >
                {compactNumber(meter.contextUsed)} / {compactNumber(meter.contextWindow)} ({meter.contextPercent}%)
              </span>
            </div>
            <div
              aria-label={`${t('web.workplace.contextWindow')} ${meter.contextPercent}%`}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={meter.contextMeterPercent}
              role="progressbar"
              style={{
                background: 'color-mix(in srgb, var(--border, #e5e7eb) 64%, transparent)',
                borderRadius: 999,
                height: 6,
                overflow: 'hidden',
                width: '100%'
              }}
            >
              <span
                style={{
                  background: 'var(--primary, #2563eb)',
                  borderRadius: 'inherit',
                  display: 'block',
                  height: '100%',
                  width: `${meter.contextMeterPercent}%`
                }}
              />
            </div>
          </div>
          <div
            style={{
              borderTop: '1px solid var(--border, #e5e7eb)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              marginTop: 12,
              paddingTop: 12
            }}
          >
            <UsageRow
              label={t('web.workplace.inputTokens')}
              value={meter.input}
            />
            {meter.cachedInput === undefined ? null : (
              <UsageRow
                label={t('web.workplace.cachedInputTokens')}
                value={meter.cachedInput}
              />
            )}
            <UsageRow
              label={t('web.workplace.outputTokens')}
              value={meter.output}
            />
            {meter.reasoningOutput === undefined ? null : (
              <UsageRow
                label={t('web.workplace.reasoningOutputTokens')}
                value={meter.reasoningOutput}
              />
            )}
            <UsageRow
              emphasis
              label={t('web.workplace.totalTokens')}
              value={meter.total}
            />
          </div>
        </aside>
      ) : null}
      <button
        aria-expanded={open}
        aria-label={t('web.workplace.showSessionUsage')}
        className="workplace-action"
        data-observation-session-usage-trigger=""
        onClick={() => setOpen((current) => !current)}
        style={{
          alignItems: 'center',
          background: open
            ? 'color-mix(in srgb, var(--primary, #2563eb) 14%, var(--background, #fff))'
            : 'color-mix(in srgb, var(--background, #fff) 88%, transparent)',
          border: `1px solid ${
            open ? 'var(--primary, #2563eb)' : 'color-mix(in srgb, var(--border, #e5e7eb) 82%, transparent)'
          }`,
          borderRadius: 9,
          color: 'var(--primary, #2563eb)',
          display: 'inline-flex',
          height: 30,
          justifyContent: 'center',
          padding: 0,
          width: 30
        }}
        title={t('web.workplace.sessionUsage')}
        type="button"
      >
        <svg
          aria-label={`${t('web.workplace.contextWindow')} ${meter.contextPercent}%`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={meter.contextMeterPercent}
          height="22"
          role="progressbar"
          viewBox="0 0 24 24"
          width="22"
        >
          <circle
            cx="12"
            cy="12"
            fill="none"
            r={RING_RADIUS}
            stroke="var(--border, #e5e7eb)"
            strokeWidth="3"
          />
          <circle
            cx="12"
            cy="12"
            fill="none"
            r={RING_RADIUS}
            stroke="currentColor"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={RING_CIRCUMFERENCE * (1 - meter.contextMeterPercent / 100)}
            strokeLinecap="round"
            strokeWidth="3"
            transform="rotate(-90 12 12)"
          />
        </svg>
      </button>
    </div>
  );
}
