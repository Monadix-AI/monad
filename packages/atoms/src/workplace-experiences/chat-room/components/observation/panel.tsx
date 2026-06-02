'use client';

import type { CSSProperties, ReactNode, RefObject } from 'react';
import type { MeshAgentUsageLimitMeter } from '../../../experience/mesh-agent-observation/mesh-agent-observation.ts';
import type { MeshAgentStreamView, Participant } from '../../../experience/types.ts';
import type { ObservationSessionUsageMeter } from './session-usage-meter.ts';

import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  CircleGaugeIcon,
  Target01Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  AgentIdentity,
  AgentInstanceAvatar,
  workspaceMono as mono,
  agentPresenceColor as presenceColor,
  resolveProductIcon,
  workspaceSans as sans
} from '@monad/ui/components/AgentAvatar';
import { VirtualList, type VirtualListHandle } from '@monad/ui/components/VirtualList';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { workplaceExperienceT } from '../../../i18n.ts';
import { ObservationSessionUsageControl } from './session-usage-control.tsx';
import {
  type ObservationTimelineRow,
  ObservationTimelineRowView,
  reconcileObservationItems,
  reconcileObservationTimelineRows
} from './timeline.tsx';
import { type ObservationTurnTimelineItem, observationTurnTimelineItems } from './turn-timeline.ts';

const observationTurnTimelineItemId = (item: ObservationTurnTimelineItem): string => item.id;
type ObservationBoundaryHandle = Pick<VirtualListHandle, 'scrollToTop' | 'scrollToBottom'>;

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

@keyframes workplace-observation-skeleton-pulse {
  0%, 100% { opacity: 0.42; }
  50% { opacity: 0.78; }
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

export function MeshAgentObservationPanel({
  agent,
  agentName,
  content,
  contentControlRef,
  contentHasItems = false,
  headerActions,
  icon,
  onBack,
  onClose,
  onLoadOlderEvents,
  onRetryOlderEvents,
  onShowEvents,
  canLoadOlderEvents,
  eventsActive,
  eventsLoadError,
  loadingOlderEvents,
  observationLoading,
  observationUnavailable,
  showEventsButton,
  stream,
  sessionUsageMeter,
  usageMeter: usageMeterProp
}: {
  agent?: Participant;
  agentName?: string;
  canLoadOlderEvents?: boolean;
  content?: ReactNode;
  contentControlRef?: RefObject<ObservationBoundaryHandle | null>;
  contentHasItems?: boolean;
  focusTurnId?: string;
  eventsActive?: boolean;
  eventsLoadError?: boolean;
  headerActions?: ReactNode;
  icon?: MeshAgentStreamView['icon'];
  loadingOlderEvents?: boolean;
  observationLoading?: boolean;
  observationUnavailable?: boolean;
  onBack?: () => void;
  onClose?: () => void;
  onLoadOlderEvents?: () => void;
  onRetryOlderEvents?: () => void;
  onShowEvents?: () => void;
  showEventsButton?: boolean;
  stream?: MeshAgentStreamView;
  sessionUsageMeter?: ObservationSessionUsageMeter | null;
  usageMeter?: MeshAgentUsageLimitMeter | null;
}): React.ReactElement {
  const t = workplaceExperienceT();
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
  const hasItems = !observationLoading && (stream?.items.length ?? 0) > 0;
  const hasScrollableItems = content !== undefined ? contentHasItems : hasItems;
  // Usage arrives through the dedicated MeshAgent usage resource or the caller's adapter fallback.
  const usageMeter = usageMeterProp ?? null;
  const listRef = useRef<VirtualListHandle>(null);
  const [follow, setFollow] = useState(true);
  const streamId = stream?.id;
  const [usageOpen, setUsageOpen] = useState(false);
  const timelineProvider = stream?.provider ?? '';
  const itemCacheRef = useRef<{ streamId?: string; items: MeshAgentStreamView['items'] }>({ items: [] });
  const streamItems = stream?.items;
  const stableItems = useMemo(() => {
    const previous = itemCacheRef.current;
    const items =
      previous.streamId === streamId
        ? reconcileObservationItems(previous.items, streamItems ?? [])
        : [...(streamItems ?? [])];
    itemCacheRef.current = { streamId, items };
    return items;
  }, [streamId, streamItems]);
  const rowCacheRef = useRef<{ streamId?: string; rows: ObservationTimelineRow[] }>({ rows: [] });
  const turnTimelineItems = useMemo(() => {
    const projected = observationTurnTimelineItems(stableItems, timelineProvider, active);
    const nextRows = projected.map((item) => item.row);
    const previous = rowCacheRef.current;
    const rows = previous.streamId === streamId ? reconcileObservationTimelineRows(previous.rows, nextRows) : nextRows;
    rowCacheRef.current = { streamId, rows };
    let rowIndex = 0;
    return projected.map((item) => ({ ...item, row: rows[rowIndex++] ?? item.row }));
  }, [active, stableItems, streamId, timelineProvider]);
  const showEventsHeader = showEventsButton || eventsActive;
  const eventsState = showEventsButton
    ? 'available'
    : eventsLoadError
      ? 'error'
      : loadingOlderEvents
        ? 'loading'
        : canLoadOlderEvents
          ? 'more'
          : 'start';
  const eventsHeader = showEventsHeader ? (
    <div
      data-events-state={eventsState}
      data-observation-list-placeholder="events"
      style={{
        boxSizing: 'border-box',
        display: 'flex',
        height: 40,
        justifyContent: 'center',
        padding: '10px 14px 0'
      }}
    >
      {showEventsButton ? (
        <button
          className="workplace-action"
          disabled={loadingOlderEvents}
          onClick={onShowEvents}
          style={{
            border: '1px solid var(--border)',
            borderRadius: 999,
            background: 'var(--secondary)',
            color: 'var(--foreground)',
            fontFamily: sans,
            fontSize: 12,
            fontWeight: 650,
            lineHeight: 1,
            minHeight: 30,
            opacity: loadingOlderEvents ? 0.62 : 1,
            padding: '0 12px'
          }}
          type="button"
        >
          {t('web.workplace.showEvents')}
        </button>
      ) : eventsLoadError ? (
        <div
          role="status"
          style={{
            alignItems: 'center',
            color: 'var(--muted-foreground)',
            display: 'flex',
            fontFamily: sans,
            fontSize: 11,
            gap: 8,
            lineHeight: '30px'
          }}
        >
          <span>{t('web.workplace.eventsLoadFailed')}</span>
          <button
            className="workplace-action"
            onClick={onRetryOlderEvents}
            style={{
              border: 0,
              background: 'transparent',
              color: 'var(--primary)',
              cursor: 'pointer',
              font: 'inherit',
              fontWeight: 650,
              padding: 0
            }}
            type="button"
          >
            {t('web.workplace.retryEvents')}
          </button>
        </div>
      ) : (
        <div
          role="status"
          style={{
            color: 'var(--muted-foreground)',
            fontFamily: sans,
            fontSize: 11,
            lineHeight: '30px',
            textAlign: 'center'
          }}
        >
          {eventsState === 'loading'
            ? t('web.workplace.loadingEvents')
            : eventsState === 'more'
              ? t('web.workplace.loadEarlierEvents')
              : t('web.workplace.eventsStart')}
        </div>
      )}
    </div>
  ) : null;
  const listHeader = (
    <>
      {eventsHeader}
      <div style={{ boxSizing: 'border-box', height: 14 }} />
    </>
  );
  const listFooter = <div style={{ height: 62 }} />;

  useEffect(() => {
    if (!streamId) return;
    setFollow(true);
    setUsageOpen(false);
  }, [streamId]);

  const loadOlderObservationEvent = useCallback(() => {
    if (loadingOlderEvents) return false;
    if (!canLoadOlderEvents) return false;
    onLoadOlderEvents?.();
    return true;
  }, [canLoadOlderEvents, loadingOlderEvents, onLoadOlderEvents]);

  const renderObservationItem = useCallback(
    (item: ObservationTurnTimelineItem) => (
      <div style={{ boxSizing: 'border-box', padding: '0 14px 10px', width: '100%' }}>
        <ObservationTimelineRowView
          provider={timelineProvider}
          row={item.row}
        />
      </div>
    ),
    [timelineProvider]
  );
  const scrollToTop = () => {
    setFollow(false);
    if (content !== undefined) contentControlRef?.current?.scrollToTop('auto');
    else listRef.current?.scrollToTop('auto');
  };
  const scrollToBottom = () => {
    setFollow(true);
    if (content !== undefined) contentControlRef?.current?.scrollToBottom('auto');
    else listRef.current?.scrollToBottom('auto');
  };
  const followLatest = () => {
    setFollow(true);
    if (content !== undefined) contentControlRef?.current?.scrollToBottom('smooth');
    else listRef.current?.scrollToBottom('smooth');
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
          overflow: 'visible',
          position: 'relative',
          zIndex: 6
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
        {sessionUsageMeter ? (
          <ObservationSessionUsageControl
            key={streamId ?? 'session-usage'}
            meter={sessionUsageMeter}
          />
        ) : null}
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
              badgeGap={7}
              icon={productIcon}
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
            aria-label={`Show ${usageMeter.title.toLowerCase()}`}
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
            title={usageMeter.title}
            type="button"
          >
            <HugeiconsIcon
              aria-hidden="true"
              icon={CircleGaugeIcon}
              size={15}
            />
          </button>
        ) : null}
        {headerActions}
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
        {content !== undefined && !observationLoading ? (
          content
        ) : hasItems ? (
          <VirtualList
            ariaLive="polite"
            className="scwf-scroll"
            controlRef={listRef}
            footer={listFooter}
            getKey={observationTurnTimelineItemId}
            header={listHeader}
            items={turnTimelineItems}
            key={streamId ?? 'observation-timeline'}
            onAtBottomChange={setFollow}
            onStartReached={loadOlderObservationEvent}
            overscan={600}
            renderItem={renderObservationItem}
            role="log"
            stickToBottom
            style={{
              boxSizing: 'border-box',
              height: '100%',
              width: '100%',
              overflowX: 'hidden',
              overscrollBehavior: 'contain'
            }}
          />
        ) : observationLoading ? (
          <ObservationLoadingSkeleton label={t('web.workplace.loadingEvents')} />
        ) : (
          <div
            data-observation-state={observationUnavailable ? 'unavailable' : 'empty'}
            style={{
              alignItems: 'center',
              boxSizing: 'border-box',
              color: 'var(--muted-foreground)',
              display: 'flex',
              flexDirection: 'column',
              fontFamily: sans,
              fontSize: 13,
              height: '100%',
              justifyContent: eventsHeader ? 'flex-start' : 'center',
              lineHeight: 1.5,
              padding: 14,
              textAlign: 'center',
              width: '100%'
            }}
          >
            {eventsHeader}
            <div style={{ maxWidth: 180 }}>
              {observationUnavailable ? t('web.workplace.eventsUnavailable') : t('web.workplace.noObservationActivity')}
            </div>
          </div>
        )}
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
            disabled={!hasScrollableItems}
            icon={ArrowUp01Icon}
            label="Scroll to top"
            onClick={scrollToTop}
          />
          <ObservationScrollButton
            disabled={!hasScrollableItems}
            icon={ArrowDown01Icon}
            label="Scroll to bottom"
            onClick={scrollToBottom}
          />
          <ObservationScrollButton
            active={follow}
            disabled={!hasScrollableItems}
            icon={Target01Icon}
            label={follow ? 'Following latest' : 'Follow latest'}
            onClick={followLatest}
          />
        </div>
      </div>
    </section>
  );
}

const OBSERVATION_SKELETON_WIDTHS = ['72%', '88%', '58%', '81%'] as const;

function ObservationLoadingSkeleton({ label }: { label: string }): React.ReactElement {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      data-observation-skeleton="true"
      data-observation-state="loading"
      role="status"
      style={{
        alignContent: 'start',
        boxSizing: 'border-box',
        display: 'grid',
        gap: 10,
        height: '100%',
        padding: 14,
        width: '100%'
      }}
    >
      {OBSERVATION_SKELETON_WIDTHS.map((width) => (
        <div
          key={width}
          style={{
            border: '1px solid color-mix(in srgb, var(--border) 72%, transparent)',
            borderRadius: 8,
            display: 'grid',
            gap: 9,
            padding: 12
          }}
        >
          <span
            style={{
              animation: 'workplace-observation-skeleton-pulse 1.4s ease-in-out infinite',
              background: 'color-mix(in srgb, var(--muted-foreground) 18%, transparent)',
              borderRadius: 999,
              display: 'block',
              height: 9,
              width: '28%'
            }}
          />
          <span
            style={{
              animation: 'workplace-observation-skeleton-pulse 1.4s ease-in-out infinite',
              background: 'color-mix(in srgb, var(--muted-foreground) 14%, transparent)',
              borderRadius: 999,
              display: 'block',
              height: 11,
              width
            }}
          />
        </div>
      ))}
    </div>
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

function UsageLimitPopover({ meter }: { meter: MeshAgentUsageLimitMeter }): React.ReactElement {
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
                {row.valueLabel ? `${row.valueLabel}  ` : ''}
                {row.resetLabel ? `Resets ${row.resetLabel}  ` : ''}
                {row.percent}%
              </span>
            </div>
            <meter
              aria-label={`${row.label} ${row.percent}%`}
              max={100}
              min={0}
              style={{ height: 5, width: '100%', accentColor: 'var(--primary)' }}
              value={row.meterPercent ?? row.percent}
            />
          </div>
        ))}
      </div>
    </aside>
  );
}
