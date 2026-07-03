'use client';

import type { CSSProperties } from 'react';
import type { NativeCliUsageLimitMeter } from '../native-cli-observation';
import type { NativeCliStreamView, Participant } from '../types';

import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  CircleGaugeIcon,
  Target01Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { ProductIcon } from '@monad/ui';
import { useEffect, useRef, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { AgentIdentity, AgentInstanceAvatar, resolveProductIcon } from '../Bits';
import { mono, presenceColor, sans } from '../styles';
import { ObservationTimelineCard, observationTimelineEntries } from './observation-cards';

const observationAvatarRingCss = `
@keyframes workplace-observation-avatar-breathe {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--observation-presence-color) 58%, transparent); }
  50% { box-shadow: 0 0 0 8px color-mix(in srgb, var(--observation-presence-color) 0%, transparent); }
}

@keyframes workplace-observation-avatar-radiate {
  0% {
    opacity: 0.72;
    transform: scale(0.9);
  }
  70%, 100% {
    opacity: 0;
    transform: scale(1.65);
  }
}

.workplace-observation-avatar {
  position: relative;
  display: inline-grid;
  flex: none;
  place-items: center;
  border: 1.5px solid transparent;
  border-radius: 999px;
}

.workplace-observation-avatar[data-active='true'] {
  border-color: var(--observation-presence-color);
  animation: workplace-observation-avatar-breathe 1.8s ease-in-out infinite;
}

.workplace-observation-avatar[data-active='true']::after {
  position: absolute;
  inset: -3px;
  border: 1.5px solid color-mix(in srgb, var(--observation-presence-color) 72%, transparent);
  border-radius: inherit;
  content: '';
  pointer-events: none;
  animation: workplace-observation-avatar-radiate 1.8s ease-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .workplace-observation-avatar,
  .workplace-observation-avatar::after {
    animation: none;
  }
}
`;

export function NativeCliObservationPanel({
  agent,
  agentName,
  icon,
  onBack,
  onClose,
  onStop,
  stream,
  usageMeter
}: {
  agent?: Participant;
  agentName?: string;
  focusTurnId?: string;
  icon?: NativeCliStreamView['icon'];
  onBack?: () => void;
  onClose?: () => void;
  onStop: (id: string) => void;
  stream?: NativeCliStreamView;
  usageMeter?: NativeCliUsageLimitMeter | null;
}): React.ReactElement {
  const t = useT();
  const displayAgent = agent ?? {
    av: (stream?.agentName ?? agentName ?? 'Agent').slice(0, 2).toUpperCase(),
    icon: stream?.icon ?? icon,
    kind: 'agent' as const,
    name: stream?.agentName ?? agentName ?? 'Agent',
    presence: stream?.status === 'running' ? ('working' as const) : ('online' as const),
    tag: stream?.tag ?? 'Agent'
  };
  const productIcon = resolveProductIcon(displayAgent);
  const active = stream?.status === 'running';
  const hasItems = (stream?.items.length ?? 0) > 0;
  const providerHistoryUnavailable = !!stream && stream.status !== 'running' && !stream.output && !hasItems;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState(true);
  const streamId = stream?.id;
  const streamStatus = stream?.status;
  const latestItem = stream?.items.at(-1);
  const latestObservationKey = `${streamId ?? ''}:${streamStatus ?? ''}:${stream?.items.length ?? 0}:${latestItem?.id ?? ''}:${latestItem?.text.length ?? 0}`;
  const [usageOpen, setUsageOpen] = useState(false);

  useEffect(() => {
    if (!streamId) return;
    setFollow(true);
    setUsageOpen(false);
  }, [streamId]);

  useEffect(() => {
    if (!latestObservationKey) return;
    const scroller = scrollRef.current;
    if (!scroller || !follow || streamStatus !== 'running') return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [follow, latestObservationKey, streamStatus]);

  const scrollToTop = () => {
    setFollow(false);
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const scrollToBottom = () => {
    setFollow(false);
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
  };
  const followLatest = () => {
    setFollow(true);
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
  };

  return (
    <section
      style={
        {
          '--observation-presence-color': presenceColor(active ? 'working' : displayAgent.presence),
          minHeight: 0,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          overflow: 'hidden'
        } as CSSProperties
      }
    >
      <style>{observationAvatarRingCss}</style>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '14px 14px 12px',
          borderBottom: '1px solid var(--border)',
          boxSizing: 'border-box',
          maxWidth: '100%',
          minWidth: 0,
          overflow: 'hidden'
        }}
      >
        {onBack ? (
          <button
            aria-label={t('web.workplace.backToAgents')}
            className="workplace-action"
            onClick={onBack}
            style={{
              width: 30,
              height: 30,
              border: '1px solid transparent',
              borderRadius: 8,
              background: 'transparent',
              color: 'var(--foreground)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: 'none',
              fontFamily: mono,
              fontSize: 15
            }}
            type="button"
          >
            ‹
          </button>
        ) : null}
        <span
          className="workplace-observation-avatar"
          data-active={active ? 'true' : undefined}
        >
          <AgentInstanceAvatar
            agent={displayAgent}
            bordered={active}
            size={30}
          />
        </span>
        <div style={{ minWidth: 0, maxWidth: '100%', overflow: 'hidden', flex: 1 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              minWidth: 0,
              maxWidth: '100%',
              overflow: 'hidden'
            }}
          >
            <AgentIdentity
              badge={
                productIcon ? (
                  <ProductIcon
                    product={productIcon}
                    size={14}
                    title={displayAgent.name}
                  />
                ) : null
              }
              badgeGap={7}
              name={displayAgent.name}
              nameStyle={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: sans,
                fontSize: 14,
                fontWeight: 700
              }}
            />
          </div>
        </div>
        {usageMeter ? (
          <button
            aria-expanded={usageOpen}
            aria-label="Show usage limits"
            className="workplace-action"
            onClick={() => setUsageOpen((open) => !open)}
            style={{
              width: 30,
              height: 30,
              border: `1px solid ${usageOpen ? 'var(--primary)' : 'var(--border)'}`,
              borderRadius: 999,
              background: usageOpen ? 'color-mix(in srgb, var(--primary) 14%, var(--background))' : 'var(--secondary)',
              color: usageOpen ? 'var(--primary)' : 'var(--foreground)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: 'none',
              padding: 0
            }}
            title="Usage limits"
            type="button"
          >
            <HugeiconsIcon
              aria-hidden="true"
              icon={CircleGaugeIcon}
              size={15}
            />
          </button>
        ) : null}
        {stream?.status === 'running' ? (
          <button
            className="workplace-action"
            onClick={() => onStop(stream.id)}
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--secondary)',
              color: 'var(--foreground)',
              fontFamily: sans,
              fontSize: 12,
              fontWeight: 650,
              padding: '7px 10px',
              flex: 'none'
            }}
            type="button"
          >
            Stop
          </button>
        ) : null}
        {onClose ? (
          <button
            aria-label={t('web.workplace.closeObservation')}
            className="workplace-action"
            onClick={onClose}
            style={{
              width: 30,
              height: 30,
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--secondary)',
              color: 'var(--foreground)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: 'none'
            }}
            type="button"
          >
            <HugeiconsIcon
              aria-hidden="true"
              icon={Cancel01Icon}
              size={15}
            />
          </button>
        ) : null}
      </header>
      {usageMeter && usageOpen ? <UsageLimitPopover meter={usageMeter} /> : null}

      <div
        style={{
          minWidth: 0,
          minHeight: 0,
          boxSizing: 'border-box',
          width: '100%',
          maxWidth: '100%',
          flex: 1,
          position: 'relative',
          overflow: 'hidden'
        }}
      >
        <div
          onScroll={() => {
            const scroller = scrollRef.current;
            if (!scroller || !follow) return;
            const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
            if (distanceFromBottom > 28) setFollow(false);
          }}
          ref={scrollRef}
          style={{
            minWidth: 0,
            minHeight: 0,
            boxSizing: 'border-box',
            width: '100%',
            maxWidth: '100%',
            height: '100%',
            overflowX: 'hidden',
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            padding: '14px 14px 62px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10
          }}
        >
          {hasItems ? (
            observationTimelineEntries(stream?.items ?? []).map((entry) => (
              <ObservationTimelineCard
                entry={entry}
                key={entry.id}
              />
            ))
          ) : (
            <div
              style={{
                margin: 'auto',
                maxWidth: 180,
                textAlign: 'center',
                color: 'var(--muted-foreground)',
                fontFamily: sans,
                fontSize: 13,
                lineHeight: 1.5
              }}
            >
              {providerHistoryUnavailable ? 'Provider history unavailable.' : 'No activity yet.'}
            </div>
          )}
        </div>
        <div
          style={{
            position: 'absolute',
            left: '50%',
            bottom: 14,
            transform: 'translateX(-50%)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            border: '1px solid color-mix(in srgb, var(--border) 82%, transparent)',
            borderRadius: 999,
            background: 'color-mix(in srgb, var(--background) 88%, transparent)',
            boxShadow: '0 8px 18px color-mix(in srgb, black 18%, transparent)',
            backdropFilter: 'blur(10px)',
            padding: 4,
            zIndex: 2
          }}
        >
          <ObservationScrollButton
            disabled={!hasItems}
            icon={ArrowUp01Icon}
            label="Scroll to top"
            onClick={scrollToTop}
          />
          <ObservationScrollButton
            disabled={!hasItems}
            icon={ArrowDown01Icon}
            label="Scroll to bottom"
            onClick={scrollToBottom}
          />
          <ObservationScrollButton
            active={follow}
            disabled={!hasItems}
            icon={Target01Icon}
            label={follow ? 'Following latest' : 'Follow latest'}
            onClick={followLatest}
          />
        </div>
      </div>
    </section>
  );
}

function ObservationScrollButton({
  active,
  disabled,
  icon,
  label,
  onClick
}: {
  active?: boolean;
  disabled?: boolean;
  icon: Parameters<typeof HugeiconsIcon>[0]['icon'];
  label: string;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      aria-label={label}
      className="workplace-action"
      disabled={disabled}
      onClick={onClick}
      style={{
        width: 30,
        height: 30,
        border: `1px solid ${active ? 'var(--primary)' : 'color-mix(in srgb, var(--border) 82%, transparent)'}`,
        borderRadius: 999,
        background: active ? 'color-mix(in srgb, var(--primary) 16%, var(--background))' : 'var(--secondary)',
        color: active ? 'var(--primary)' : 'var(--foreground)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.45 : 1,
        padding: 0
      }}
      title={label}
      type="button"
    >
      <HugeiconsIcon
        aria-hidden="true"
        icon={icon}
        size={14}
      />
    </button>
  );
}

function UsageLimitPopover({ meter }: { meter: NativeCliUsageLimitMeter }): React.ReactElement {
  return (
    <aside
      style={{
        position: 'absolute',
        top: 52,
        right: 12,
        zIndex: 5,
        width: 'min(330px, calc(100% - 24px))',
        boxSizing: 'border-box',
        border: '1px solid color-mix(in srgb, var(--border) 88%, transparent)',
        borderRadius: 12,
        background: 'color-mix(in srgb, var(--background) 96%, var(--card))',
        boxShadow: '0 16px 34px color-mix(in srgb, black 24%, transparent)',
        padding: '10px 11px 11px',
        fontFamily: sans
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          marginBottom: 9
        }}
      >
        <span style={{ color: 'var(--foreground)', fontSize: 13, fontWeight: 650 }}>{meter.title}</span>
        <span style={{ color: 'var(--muted-foreground)', fontFamily: mono, fontSize: 10 }}>{meter.rows.length}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {meter.rows.map((row) => (
          <div
            key={row.id}
            style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 10,
                minWidth: 0,
                fontSize: 12
              }}
            >
              <span
                style={{
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: 'var(--foreground)',
                  fontWeight: 560
                }}
              >
                {row.label}
              </span>
              <span
                style={{
                  flex: 'none',
                  color: 'var(--muted-foreground)',
                  fontVariantNumeric: 'tabular-nums'
                }}
              >
                {row.resetLabel ? `Resets ${row.resetLabel}  ` : ''}
                {row.percent}%
              </span>
            </div>
            <meter
              aria-label={`${row.label} ${row.percent}%`}
              max={100}
              min={0}
              style={{ height: 5, width: '100%', accentColor: 'var(--primary)' }}
              value={row.percent}
            />
          </div>
        ))}
      </div>
    </aside>
  );
}
