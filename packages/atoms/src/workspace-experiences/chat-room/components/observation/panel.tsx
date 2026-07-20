'use client';

import type { AgentObservationCard, AgentObservationEvent } from '@monad/protocol';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import type { MeshAgentUsageLimitMeter } from '../../../experience/mesh-agent-observation/mesh-agent-observation.ts';
import type { MeshAgentStreamView, Participant } from '../../../experience/types.ts';
import type { ObservationCollapseCommand } from './card-shell.tsx';

import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  CircleGaugeIcon,
  GroupItemsIcon,
  ListViewIcon,
  Target01Icon,
  UnfoldLessIcon,
  UnfoldMoreIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { ProductIcon } from '@monad/ui';
import {
  AgentIdentity,
  AgentInstanceAvatar,
  workspaceMono as mono,
  agentPresenceColor as presenceColor,
  resolveProductIcon,
  workspaceSans as sans
} from '@monad/ui/components/AgentAvatar';
import { VirtualList, type VirtualListHandle } from '@monad/ui/components/VirtualList';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { workspaceExperienceT } from '../../../i18n.ts';
import {
  type ObservationTimelineRow,
  ObservationTimelineRowView,
  observationTimelineEntries,
  observationTimelineRows,
  reconcileObservationItems,
  reconcileObservationTimelineRows
} from './timeline.tsx';

const observationRowId = (row: ObservationTimelineRow): string => row.id;
type ObservationRenderMode = 'detail' | 'summary';
type ObservationBoundaryHandle = Pick<VirtualListHandle, 'scrollToTop' | 'scrollToBottom'>;

export function jumpSummaryToLoadedTop(
  scroller: { scrollTop: number },
  startArmed: { current: boolean },
  loadOlder: () => unknown
): void {
  scroller.scrollTop = 0;
  if (loadOlder() !== false) startArmed.current = false;
}

type SummaryObservationTurn = {
  id: string;
  done: boolean;
  durationLabel: string;
  summaryText?: string;
  rows: ObservationTimelineRow[];
};

function eventFromCard(card: AgentObservationCard): AgentObservationEvent | undefined {
  const event = card.payload.event ?? card.payload.call ?? card.payload.result;
  return event && typeof event === 'object' && !Array.isArray(event) ? (event as AgentObservationEvent) : undefined;
}

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
  onRenderModeChange,
  onRetryOlderEvents,
  onShowEvents,
  canLoadOlderEvents,
  defaultRenderMode = 'detail',
  eventsActive,
  eventsLoadError,
  loadingOlderEvents,
  observationLoading,
  observationUnavailable,
  renderMode: controlledRenderMode,
  showEventsButton,
  showObservationControls = true,
  stream,
  usageMeter: usageMeterProp
}: {
  agent?: Participant;
  agentName?: string;
  canLoadOlderEvents?: boolean;
  content?: ReactNode;
  contentControlRef?: RefObject<ObservationBoundaryHandle | null>;
  contentHasItems?: boolean;
  defaultRenderMode?: ObservationRenderMode;
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
  onRenderModeChange?: (mode: ObservationRenderMode) => void;
  onRetryOlderEvents?: () => void;
  onShowEvents?: () => void;
  renderMode?: ObservationRenderMode;
  showEventsButton?: boolean;
  showObservationControls?: boolean;
  stream?: MeshAgentStreamView;
  usageMeter?: MeshAgentUsageLimitMeter | null;
}): React.ReactElement {
  const t = workspaceExperienceT();
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
  const summaryListRef = useRef<HTMLDivElement>(null);
  const summaryStartArmedRef = useRef(true);
  const summaryLayoutRef = useRef<{ firstKey: string | null; height: number; streamId?: string }>({
    firstKey: null,
    height: 0
  });
  const [follow, setFollow] = useState(true);
  const [allExpanded, setAllExpanded] = useState(true);
  const [collapseCommand, setCollapseCommand] = useState<ObservationCollapseCommand>({ collapsed: false });
  const [uncontrolledRenderMode, setUncontrolledRenderMode] = useState<ObservationRenderMode>(defaultRenderMode);
  const renderMode = controlledRenderMode ?? uncontrolledRenderMode;
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
  const timelineRows = useMemo(() => {
    const nextRows = observationTimelineRows(observationTimelineEntries(stableItems, timelineProvider, active));
    const previous = rowCacheRef.current;
    const rows = previous.streamId === streamId ? reconcileObservationTimelineRows(previous.rows, nextRows) : nextRows;
    rowCacheRef.current = { streamId, rows };
    return rows;
  }, [active, stableItems, streamId, timelineProvider]);
  const summaryTurns = useMemo(
    () => summaryObservationTurns(stableItems, timelineProvider),
    [stableItems, timelineProvider]
  );
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
    setAllExpanded(true);
    setCollapseCommand({ collapsed: false });
  }, [streamId]);

  const loadOlderObservationEvent = useCallback(() => {
    if (loadingOlderEvents) return false;
    if (!canLoadOlderEvents) return false;
    onLoadOlderEvents?.();
    return true;
  }, [canLoadOlderEvents, loadingOlderEvents, onLoadOlderEvents]);

  const firstSummaryTurnId = summaryTurns[0]?.id;
  useLayoutEffect(() => {
    const scroller = summaryListRef.current;
    if (!scroller) return;
    const previous = summaryLayoutRef.current;
    if (renderMode === 'summary' && previous.streamId !== streamId) {
      summaryStartArmedRef.current = true;
      scroller.scrollTop = scroller.scrollHeight;
      summaryLayoutRef.current = { firstKey: firstSummaryTurnId ?? null, height: scroller.scrollHeight, streamId };
      return;
    }
    if (previous.streamId === streamId && previous.firstKey && firstSummaryTurnId !== previous.firstKey) {
      summaryStartArmedRef.current = false;
      scroller.scrollTop += scroller.scrollHeight - previous.height;
    }
    summaryLayoutRef.current = { firstKey: firstSummaryTurnId ?? null, height: scroller.scrollHeight, streamId };
  }, [firstSummaryTurnId, renderMode, streamId]);

  const renderObservationRow = useCallback(
    (row: ObservationTimelineRow) => (
      <div style={{ boxSizing: 'border-box', padding: '0 14px 10px', width: '100%' }}>
        <ObservationTimelineRowView
          collapseCommand={collapseCommand}
          provider={timelineProvider}
          row={row}
        />
      </div>
    ),
    [collapseCommand, timelineProvider]
  );
  const scrollToTop = () => {
    setFollow(false);
    if (content !== undefined) contentControlRef?.current?.scrollToTop('auto');
    else if (renderMode === 'detail') listRef.current?.scrollToTop('auto');
    else if (summaryListRef.current) {
      jumpSummaryToLoadedTop(summaryListRef.current, summaryStartArmedRef, loadOlderObservationEvent);
    }
  };
  const scrollToBottom = () => {
    setFollow(true);
    if (content !== undefined) contentControlRef?.current?.scrollToBottom('auto');
    else if (renderMode === 'detail') listRef.current?.scrollToBottom('auto');
    else {
      const scroller = summaryListRef.current;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }
  };
  const followLatest = () => {
    setFollow(true);
    if (content !== undefined) contentControlRef?.current?.scrollToBottom('smooth');
    else if (renderMode === 'detail') listRef.current?.scrollToBottom('smooth');
    else {
      const scroller = summaryListRef.current;
      scroller?.scrollTo({ behavior: 'smooth', top: scroller.scrollHeight });
    }
  };
  const toggleAllRows = () => {
    const nextCollapsed = allExpanded;
    setCollapseCommand({ collapsed: nextCollapsed });
    setAllExpanded(!nextCollapsed);
  };
  const setRenderMode = (mode: ObservationRenderMode) => {
    if (controlledRenderMode === undefined) setUncontrolledRenderMode(mode);
    onRenderModeChange?.(mode);
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
        {showObservationControls ? (
          <>
            <button
              aria-label={allExpanded ? 'Collapse all activity' : 'Expand all activity'}
              className="workplace-action"
              disabled={!hasItems || renderMode === 'summary'}
              onClick={toggleAllRows}
              style={headerIconButtonStyle(allExpanded, !hasItems || renderMode === 'summary')}
              title={allExpanded ? 'Collapse all activity' : 'Expand all activity'}
              type="button"
            >
              <HugeiconsIcon
                aria-hidden="true"
                icon={allExpanded ? UnfoldLessIcon : UnfoldMoreIcon}
                size={15}
                strokeWidth={2}
              />
            </button>
            <ObservationModeIconButton
              mode={renderMode}
              onClick={() => setRenderMode(renderMode === 'detail' ? 'summary' : 'detail')}
            />
          </>
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
        ) : hasItems && renderMode === 'detail' ? (
          <VirtualList
            ariaLive="polite"
            className="scwf-scroll"
            controlRef={listRef}
            footer={listFooter}
            getKey={observationRowId}
            header={listHeader}
            items={timelineRows}
            key={streamId ?? 'observation-detail'}
            onAtBottomChange={setFollow}
            onStartReached={loadOlderObservationEvent}
            overscan={600}
            renderItem={renderObservationRow}
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
        ) : hasItems ? (
          <div
            aria-live="polite"
            className="scwf-scroll"
            key={streamId ?? 'observation-summary'}
            onScroll={(event) => {
              const atStart = event.currentTarget.scrollTop <= 240;
              if (atStart && summaryStartArmedRef.current) {
                if (loadOlderObservationEvent() !== false) summaryStartArmedRef.current = false;
              } else if (!atStart) {
                summaryStartArmedRef.current = true;
              }
            }}
            ref={summaryListRef}
            role="log"
            style={{
              boxSizing: 'border-box',
              height: '100%',
              overflowX: 'hidden',
              overflowY: 'auto',
              overscrollBehavior: 'contain',
              padding: '14px 14px 62px',
              width: '100%'
            }}
          >
            {eventsHeader}
            <div style={{ display: 'grid', gap: 10 }}>
              {summaryTurns.map((turn) => (
                <SummaryObservationTurnView
                  key={turn.id}
                  provider={timelineProvider}
                  turn={turn}
                />
              ))}
            </div>
          </div>
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

function ObservationModeIconButton({
  mode,
  onClick
}: {
  mode: ObservationRenderMode;
  onClick: () => void;
}): React.ReactElement {
  const summary = mode === 'summary';
  const label = summary ? 'Show individual activity' : 'Group activity by turn';
  return (
    <button
      aria-label={label}
      aria-pressed={summary}
      className="workplace-action"
      onClick={onClick}
      style={headerIconButtonStyle(summary)}
      title={label}
      type="button"
    >
      <HugeiconsIcon
        aria-hidden="true"
        icon={summary ? ListViewIcon : GroupItemsIcon}
        size={15}
        strokeWidth={2}
      />
    </button>
  );
}

function SummaryObservationTurnView({
  provider,
  turn
}: {
  provider: string;
  turn: SummaryObservationTurn;
}): React.ReactElement {
  return (
    <details
      data-observation-turn-mode="summary"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--secondary)',
        overflow: 'hidden'
      }}
    >
      <summary
        style={{
          cursor: 'pointer',
          display: 'grid',
          gap: 8,
          listStyle: 'none',
          padding: '10px 12px'
        }}
      >
        <span
          style={{
            color: 'var(--muted-foreground)',
            fontFamily: mono,
            fontSize: 11,
            fontWeight: 700,
            textTransform: 'uppercase'
          }}
        >
          {turn.done ? 'Completed' : 'Running'} for {turn.durationLabel}
          {turn.done ? '' : '…'}
        </span>
        {turn.summaryText ? (
          <span
            style={{
              color: 'var(--foreground)',
              fontFamily: sans,
              fontSize: 13,
              lineHeight: 1.45,
              overflowWrap: 'anywhere',
              whiteSpace: 'pre-wrap'
            }}
          >
            {turn.summaryText}
          </span>
        ) : null}
        <span
          style={{
            color: 'var(--muted-foreground)',
            fontFamily: sans,
            fontSize: 11,
            fontWeight: 650
          }}
        >
          Show turn details
        </span>
      </summary>
      <div style={{ display: 'grid', gap: 10, padding: '0 10px 10px' }}>
        {turn.rows.map((row) => (
          <ObservationTimelineRowView
            key={row.id}
            provider={provider}
            row={row}
          />
        ))}
      </div>
    </details>
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

function headerIconButtonStyle(active: boolean, disabled = false): CSSProperties {
  return {
    width: 30,
    height: 30,
    border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
    borderRadius: 999,
    background: active ? 'color-mix(in srgb, var(--primary) 14%, var(--background))' : 'var(--secondary)',
    color: active ? 'var(--primary)' : 'var(--foreground)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 'none',
    opacity: disabled ? 0.45 : 1,
    padding: 0
  };
}

function summaryObservationTurns(cards: readonly AgentObservationCard[], provider: string): SummaryObservationTurn[] {
  const groups: AgentObservationCard[][] = [];
  let current: AgentObservationCard[] = [];
  const flush = () => {
    if (current.length > 0) groups.push(current);
    current = [];
  };

  for (const card of cards) {
    const event = eventFromCard(card);
    if (event?.kind === 'turn-start' && current.length > 0) flush();
    current.push(card);
    if (event?.kind === 'turn-end') flush();
  }
  flush();

  return groups.map((group, index) => {
    const events = group.map(eventFromCard).filter((event): event is AgentObservationEvent => event !== undefined);
    const done = events.at(-1)?.kind === 'turn-end';
    const startMs = firstTimestampMs(group) ?? Date.now();
    const endMs = done ? (lastTimestampMs(group) ?? startMs) : Date.now();
    const summaryText = [...events]
      .reverse()
      .find((event) => event.kind === 'assistant-message' && event.text?.trim())?.text;
    const detailItems = group.filter((card) => {
      const event = eventFromCard(card);
      return event?.kind !== 'turn-start' && event?.kind !== 'turn-end';
    });
    const rows = observationTimelineRows(observationTimelineEntries(detailItems, provider));
    return {
      id: `compact-turn:${group[0]?.id ?? index}`,
      done,
      durationLabel: formatTurnDuration(Math.max(0, endMs - startMs)),
      summaryText,
      rows
    };
  });
}

function firstTimestampMs(items: readonly AgentObservationCard[]): number | undefined {
  for (const item of items) {
    const ms = timestampMs(eventFromCard(item)?.at ?? item.at);
    if (ms !== undefined) return ms;
  }
  return undefined;
}

function lastTimestampMs(items: readonly AgentObservationCard[]): number | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const ms = item ? timestampMs(eventFromCard(item)?.at ?? item.at) : undefined;
    if (ms !== undefined) return ms;
  }
  return undefined;
}

function timestampMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function formatTurnDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes.toString().padStart(2, '0')}m${seconds.toString().padStart(2, '0')}s`;
  if (minutes > 0) return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
  return `${seconds}s`;
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
