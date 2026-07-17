'use client';

import type { AgentObservationEvent } from '@monad/protocol';
import type { CSSProperties } from 'react';
import type { ExternalAgentUsageLimitMeter } from '../../../experience/external-agent-observation/external-agent-observation.ts';
import type { ExternalAgentStreamView, Participant } from '../../../experience/types.ts';
import type { ObservationCollapseCommand } from './card-shell.tsx';

import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  CircleGaugeIcon,
  ExpandParagraphIcon,
  ReduceParagraphIcon,
  Target01Icon
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
import { useFirstItemIndex } from '@monad/ui/hooks/use-first-item-index';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { workspaceExperienceT } from '../../../i18n.ts';
import {
  type ObservationTimelineRow,
  ObservationTimelineRowView,
  observationTimelineEntries,
  observationTimelineRows
} from './timeline.tsx';

const observationRowId = (row: ObservationTimelineRow): string => row.id;
type ObservationRenderMode = 'detail' | 'summary';

type SummaryObservationTurn = {
  id: string;
  done: boolean;
  durationLabel: string;
  summaryText?: string;
  rows: ObservationTimelineRow[];
};

export function observationFollowResetKey(stream?: { id?: string; status?: string }): string {
  return `${stream?.id ?? ''}:${stream?.status ?? ''}`;
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

export function ExternalAgentObservationPanel({
  agent,
  agentName,
  icon,
  onBack,
  onClose,
  onLoadOlderHistory,
  onRenderModeChange,
  onShowHistory,
  onStop,
  canLoadOlderHistory,
  defaultRenderMode = 'detail',
  loadingOlderHistory,
  renderMode: controlledRenderMode,
  showHistoryButton,
  stream,
  usageMeter: usageMeterProp
}: {
  agent?: Participant;
  agentName?: string;
  canLoadOlderHistory?: boolean;
  defaultRenderMode?: ObservationRenderMode;
  focusTurnId?: string;
  icon?: ExternalAgentStreamView['icon'];
  loadingOlderHistory?: boolean;
  onBack?: () => void;
  onClose?: () => void;
  onLoadOlderHistory?: () => void;
  onRenderModeChange?: (mode: ObservationRenderMode) => void;
  onShowHistory?: () => void;
  onStop: (id: string) => void;
  renderMode?: ObservationRenderMode;
  showHistoryButton?: boolean;
  stream?: ExternalAgentStreamView;
  usageMeter?: ExternalAgentUsageLimitMeter | null;
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
  const hasItems = (stream?.items.length ?? 0) > 0;
  const providerHistoryUnavailable = !!stream && stream.status !== 'running' && !stream.output && !hasItems;
  // The daemon already normalizes the usage meter with the same adapter it uses for parseOutput (see
  // observeFromStore/observeWithProviderHistory) — the caller passes it via `usageMeter`; this
  // component never falls back to client-side re-derivation.
  const usageMeter = usageMeterProp ?? null;
  const listRef = useRef<VirtualListHandle>(null);
  const [follow, setFollow] = useState(true);
  const [allExpanded, setAllExpanded] = useState(true);
  const [collapseCommand, setCollapseCommand] = useState<ObservationCollapseCommand>({ collapsed: false });
  const [uncontrolledRenderMode, setUncontrolledRenderMode] = useState<ObservationRenderMode>(defaultRenderMode);
  const renderMode = controlledRenderMode ?? uncontrolledRenderMode;
  const streamId = stream?.id;
  const streamStatus = stream?.status;
  const followResetKey = observationFollowResetKey(stream);
  const [usageOpen, setUsageOpen] = useState(false);
  const timelineProvider = stream?.provider ?? '';
  const timelineRows = useMemo(
    () => observationTimelineRows(observationTimelineEntries(stream?.items ?? [], timelineProvider, active)),
    [active, stream?.items, timelineProvider]
  );
  const summaryTurns = useMemo(
    () => summaryObservationTurns(stream?.items ?? [], timelineProvider),
    [stream?.items, timelineProvider]
  );
  const firstItemIndex = useFirstItemIndex(timelineRows, observationRowId);
  const showHistoryHeader = showHistoryButton || loadingOlderHistory;
  const historyHeader = showHistoryHeader ? (
    <div
      data-observation-list-placeholder="history"
      style={{
        boxSizing: 'border-box',
        display: 'flex',
        justifyContent: 'center',
        padding: '10px 14px 0'
      }}
    >
      {showHistoryButton ? (
        <button
          className="workplace-action"
          disabled={loadingOlderHistory}
          onClick={onShowHistory}
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
            opacity: loadingOlderHistory ? 0.62 : 1,
            padding: '0 12px'
          }}
          type="button"
        >
          {loadingOlderHistory ? 'Loading history…' : 'Show history'}
        </button>
      ) : (
        <div
          style={{
            color: 'var(--muted-foreground)',
            fontFamily: sans,
            fontSize: 11,
            lineHeight: '30px',
            textAlign: 'center'
          }}
        >
          Loading history…
        </div>
      )}
    </div>
  ) : null;
  const listHeader = (
    <>
      {historyHeader}
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

  useEffect(() => {
    if (!followResetKey) return;
    if (!follow || streamStatus !== 'running') return;
    listRef.current?.scrollToBottom('auto');
  }, [follow, followResetKey, streamStatus]);

  const loadOlderObservationHistory = useCallback(() => {
    if (canLoadOlderHistory && !loadingOlderHistory) onLoadOlderHistory?.();
  }, [canLoadOlderHistory, loadingOlderHistory, onLoadOlderHistory]);

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
    const firstRow = timelineRows[0];
    if (firstRow) listRef.current?.scrollToKey(firstRow.id, { align: 'start', behavior: 'smooth' });
  };
  const scrollToBottom = () => {
    setFollow(false);
    listRef.current?.scrollToBottom('smooth');
  };
  const followLatest = () => {
    setFollow(true);
    listRef.current?.scrollToBottom('smooth');
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
        <button
          aria-label={allExpanded ? 'Collapse all observations' : 'Expand all observations'}
          className="workplace-action"
          disabled={!hasItems || renderMode === 'summary'}
          onClick={toggleAllRows}
          style={headerIconButtonStyle(allExpanded, !hasItems || renderMode === 'summary')}
          title={allExpanded ? 'Collapse all observations' : 'Expand all observations'}
          type="button"
        >
          <HugeiconsIcon
            aria-hidden="true"
            icon={allExpanded ? ReduceParagraphIcon : ExpandParagraphIcon}
            size={15}
            strokeWidth={2}
          />
        </button>
        <ObservationModeIconButton
          mode={renderMode}
          onClick={() => setRenderMode(renderMode === 'detail' ? 'summary' : 'detail')}
        />
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
        {hasItems && renderMode === 'detail' ? (
          <VirtualList
            ariaLive="polite"
            className="scwf-scroll"
            controlRef={listRef}
            firstItemIndex={firstItemIndex}
            footer={listFooter}
            getKey={observationRowId}
            header={listHeader}
            items={timelineRows}
            onAtBottomChange={setFollow}
            onStartReached={loadOlderObservationHistory}
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
            {historyHeader}
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
        ) : (
          <div
            style={{
              alignItems: 'center',
              boxSizing: 'border-box',
              color: 'var(--muted-foreground)',
              display: 'flex',
              flexDirection: 'column',
              fontFamily: sans,
              fontSize: 13,
              height: '100%',
              justifyContent: historyHeader ? 'flex-start' : 'center',
              lineHeight: 1.5,
              padding: 14,
              textAlign: 'center',
              width: '100%'
            }}
          >
            {historyHeader}
            <div style={{ maxWidth: 180 }}>
              {providerHistoryUnavailable ? 'Agent currently not running' : 'No activity yet.'}
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

function ObservationModeIconButton({
  mode,
  onClick
}: {
  mode: ObservationRenderMode;
  onClick: () => void;
}): React.ReactElement {
  const summary = mode === 'summary';
  const label = summary ? 'Switch observation view to Detail' : 'Switch observation view to Summary';
  return (
    <button
      aria-label={label}
      aria-pressed={summary}
      className="workplace-action"
      onClick={onClick}
      style={headerIconButtonStyle(summary)}
      title={summary ? 'Summary observation view' : 'Detail observation view'}
      type="button"
    >
      <HugeiconsIcon
        aria-hidden="true"
        icon={summary ? ExpandParagraphIcon : ReduceParagraphIcon}
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

function summaryObservationTurns(items: readonly AgentObservationEvent[], provider: string): SummaryObservationTurn[] {
  const groups: AgentObservationEvent[][] = [];
  let current: AgentObservationEvent[] = [];
  const flush = () => {
    if (current.length > 0) groups.push(current);
    current = [];
  };

  for (const item of items) {
    if (item.kind === 'turn-start' && current.length > 0) flush();
    current.push(item);
    if (item.kind === 'turn-end') flush();
  }
  flush();

  return groups.map((group, index) => {
    const done = group.at(-1)?.kind === 'turn-end';
    const startMs = firstTimestampMs(group) ?? Date.now();
    const endMs = done ? (lastTimestampMs(group) ?? startMs) : Date.now();
    const summaryText = [...group]
      .reverse()
      .find((event) => event.kind === 'assistant-message' && event.text?.trim())?.text;
    const detailItems = group.filter((event) => event.kind !== 'turn-start' && event.kind !== 'turn-end');
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

function firstTimestampMs(items: readonly AgentObservationEvent[]): number | undefined {
  for (const item of items) {
    const ms = timestampMs(item.at);
    if (ms !== undefined) return ms;
  }
  return undefined;
}

function lastTimestampMs(items: readonly AgentObservationEvent[]): number | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const ms = timestampMs(items[index]?.at);
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

function UsageLimitPopover({ meter }: { meter: ExternalAgentUsageLimitMeter }): React.ReactElement {
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
