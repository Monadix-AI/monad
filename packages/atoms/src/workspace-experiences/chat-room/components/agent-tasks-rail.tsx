import type { NativeCliObservationAccessResponse, NativeCliUsageResponse, TranscriptTargetId } from '@monad/protocol';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent
} from 'react';
import type { NativeCliStreamView, Participant } from '../../experience/types.ts';

import { BrainIcon, EyeIcon, MegaphoneIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  useLazyGetNativeAgentDeliveryObservationQuery,
  useLazyGetNativeCliHistoryPageQuery,
  useLazyGetNativeCliObservationQuery,
  useLazyGetNativeCliUsageQuery
} from '@monad/sdk-atom-client-rtk';
import { ProductIcon } from '@monad/ui';
import {
  AgentIdentity,
  AgentInstanceAvatar,
  agentPresenceColor as presenceColor,
  resolveProductIcon,
  workspaceSans as sans,
  workspaceSectionLabelStyle as sectionLabel
} from '@monad/ui/components/AgentAvatar';
import { useCallback, useEffect, useRef, useState } from 'react';

import { workspaceExperienceT } from '../../i18n.ts';
import { useChatRoomExperienceStore } from '../store.ts';
import {
  agentObservationStream,
  groupProjectRailAgents,
  isActiveRailAgent,
  observationProjectionFromAccess,
  observedRailAgent,
  streamWithObservationProjection,
  usageMeterFromObservationAccess
} from '../utils/agent-rail-model.ts';
import { NativeCliObservationPanel } from './observation/panel.tsx';

const RAIL_WIDTH_STORAGE_KEY = 'monad.workplace.agentRail.width';
const DEFAULT_RAIL_WIDTH = 296;
const MIN_RAIL_WIDTH = 260;
const MAX_RAIL_WIDTH = 620;

function usePolledValue<T>(args: {
  enabled: boolean;
  intervalMs: number;
  load: () => Promise<T>;
  resetKey: string;
}): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  const loadRef = useRef(args.load);
  loadRef.current = args.load;
  useEffect(() => {
    if (!args.enabled) {
      setValue(undefined);
      return;
    }
    let cancelled = false;
    const load = () => {
      void loadRef.current().then(
        (next) => {
          if (!cancelled) setValue(next);
        },
        () => {
          if (!cancelled) setValue(undefined);
        }
      );
    };
    load();
    if (args.intervalMs <= 0)
      return () => {
        cancelled = true;
      };
    const timer = window.setInterval(load, args.intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [args.enabled, args.intervalMs]);
  return value;
}

type ObservationHistoryPageState = {
  items: NativeCliStreamView['items'];
  nextCursor: string | null;
  loading: boolean;
  exhausted: boolean;
};

function observationItemSignature(item: NativeCliStreamView['items'][number]): string {
  return JSON.stringify({
    role: item.role,
    source: item.source,
    providerEventType: item.providerEventType,
    text: item.text,
    raw: item.raw
  });
}

function mergeObservationItems(
  historyItems: NativeCliStreamView['items'],
  liveItems: NativeCliStreamView['items']
): NativeCliStreamView['items'] {
  const seen = new Set<string>();
  const merged: NativeCliStreamView['items'] = [];
  for (const item of [...historyItems, ...liveItems]) {
    const signature = observationItemSignature(item);
    if (seen.has(signature)) continue;
    seen.add(signature);
    merged.push(item);
  }
  return merged;
}

function streamWithHistoryPages(
  stream: NativeCliStreamView | undefined,
  history: ObservationHistoryPageState | undefined
): NativeCliStreamView | undefined {
  if (!stream || !history || history.items.length === 0) return stream;
  return {
    ...stream,
    items: mergeObservationItems(history.items, stream.items),
    output: stream.output
  };
}

function clampRailWidth(width: number): number {
  return Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, Math.round(width)));
}

function agentActivityPhaseMeta(agent: Participant): {
  label: string;
  icon: typeof EyeIcon;
} {
  if (agent.activityPhase === 'reading') return { label: 'Reading', icon: EyeIcon };
  if (agent.activityPhase === 'speaking') return { label: 'Speaking', icon: MegaphoneIcon };
  return { label: 'Thinking', icon: BrainIcon };
}

const agentStatusRingCss = `
@keyframes workplace-agent-status-breathe {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--agent-presence-color) 58%, transparent); }
  50% { box-shadow: 0 0 0 8px color-mix(in srgb, var(--agent-presence-color) 0%, transparent); }
}

@keyframes workplace-agent-status-radiate {
  0% {
    opacity: 0.72;
    transform: scale(0.9);
  }
  70%, 100% {
    opacity: 0;
    transform: scale(1.65);
  }
}

@keyframes workplace-agent-phase-thinking {
  to { transform: rotate(360deg); }
}

@keyframes workplace-agent-phase-reading {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-2px); }
}

@keyframes workplace-agent-phase-speaking {
  0%, 100% { transform: scale(1); }
  45% { transform: scale(1.22); }
}

.workplace-agent-status-row {
  appearance: none;
  width: 100%;
  min-height: 36px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  box-sizing: border-box;
  background: transparent;
  color: var(--sidebar-foreground);
  font-family: var(--font-sans), ui-sans-serif, system-ui, sans-serif;
  font-size: 14px;
  line-height: 1;
  text-align: left;
  transition: background-color 150ms ease-out, color 150ms ease-out;
}

.workplace-agent-status-row:hover {
  background: var(--sidebar-accent);
  color: var(--sidebar-accent-foreground);
}

.workplace-agent-status-row[data-selected='true'] {
  background: var(--sidebar-accent);
  color: var(--sidebar-accent-foreground);
}

.workplace-agent-status-avatar {
  position: relative;
  display: inline-grid;
  flex: none;
  place-items: center;
  border: 1.5px solid transparent;
  border-radius: 999px;
}

.workplace-agent-status-avatar[data-active='true'] {
  border-color: var(--agent-presence-color);
  animation: workplace-agent-status-breathe 1.8s ease-in-out infinite;
}

.workplace-agent-status-avatar[data-active='true']::after {
  position: absolute;
  inset: -3px;
  border: 1.5px solid color-mix(in srgb, var(--agent-presence-color) 72%, transparent);
  border-radius: inherit;
  content: '';
  pointer-events: none;
  animation: workplace-agent-status-radiate 1.8s ease-out infinite;
}

.workplace-agent-status-phase {
  position: absolute;
  right: -5px;
  bottom: -5px;
  z-index: 2;
  width: 17px;
  height: 17px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--agent-presence-color) 72%, var(--sidebar-border));
  border-radius: 999px;
  background: var(--sidebar);
  color: var(--agent-presence-color);
  box-shadow: 0 0 0 2px var(--sidebar), 0 0 12px -4px var(--agent-presence-color);
}

.workplace-agent-status-phase[data-phase='thinking'] svg {
  animation: workplace-agent-phase-thinking 1.4s linear infinite;
}

.workplace-agent-status-phase[data-phase='reading'] svg {
  animation: workplace-agent-phase-reading 1.05s ease-in-out infinite;
}

.workplace-agent-status-phase[data-phase='speaking'] svg {
  animation: workplace-agent-phase-speaking 0.8s ease-in-out infinite;
}

.workplace-agent-status-name {
  min-width: 0;
  flex: 1;
  align-items: center;
  color: var(--foreground);
  line-height: 1;
}

.workplace-agent-status-name > span {
  display: inline-flex;
  align-items: center;
}

@media (prefers-reduced-motion: reduce) {
  .workplace-agent-status-avatar,
  .workplace-agent-status-avatar::after,
  .workplace-agent-status-phase svg {
    animation: none;
  }
}
`;

type AgentTasksRailRoom = {
  nativeCliStreams: NativeCliStreamView[];
  projectId: string;
  railAgents: Participant[];
  stopNativeCli: (id: string) => void;
};

export function AgentTasksRail({ room }: { room: AgentTasksRailRoom }): React.ReactElement {
  const t = workspaceExperienceT();
  const [triggerNativeAgentDeliveryObservation] = useLazyGetNativeAgentDeliveryObservationQuery();
  const [triggerNativeCliHistoryPage] = useLazyGetNativeCliHistoryPageQuery();
  const [triggerNativeCliObservation] = useLazyGetNativeCliObservationQuery();
  const [triggerNativeCliUsage] = useLazyGetNativeCliUsageQuery();
  const [railWidth, setRailWidth] = useState(DEFAULT_RAIL_WIDTH);
  const [resizing, setResizing] = useState(false);
  const dragStartRef = useRef({ pointerX: 0, width: DEFAULT_RAIL_WIDTH });
  const suppressMouseResizeRef = useRef(false);
  const effectiveRailWidth = railWidth;
  const observation = useChatRoomExperienceStore((state) =>
    state.railObservation?.projectId === room.projectId ? state.railObservation : null
  );
  const observeProjectAgent = useChatRoomExperienceStore((state) => state.observeProjectAgent);
  const closeRailObservation = useChatRoomExperienceStore((state) => state.closeRailObservation);
  const groups = groupProjectRailAgents(room.railAgents);
  const observedStream = agentObservationStream(observation, room.nativeCliStreams);
  const observedNativeCliSessionId = observation?.nativeCliSessionId ?? observedStream?.id;
  const observedDeliveryId = observation?.deliveryId;
  const observationHistoryResetKey = [observedDeliveryId, observedNativeCliSessionId].filter(Boolean).join(':');
  const [historyPages, setHistoryPages] = useState<ObservationHistoryPageState | undefined>(undefined);
  const [historyRequested, setHistoryRequested] = useState(false);
  const observationPollMs = observedStream?.status === 'running' ? 900 : 0;
  const observationAccess = usePolledValue<NativeCliObservationAccessResponse>({
    enabled: Boolean((observedDeliveryId || observedNativeCliSessionId) && observation),
    intervalMs: observationPollMs,
    load: () =>
      observedDeliveryId
        ? triggerNativeAgentDeliveryObservation({
            id: observedDeliveryId,
            transcriptTargetId: room.projectId as TranscriptTargetId
          }).unwrap()
        : triggerNativeCliObservation({
            id: observedNativeCliSessionId as string,
            transcriptTargetId: room.projectId as TranscriptTargetId
          }).unwrap(),
    resetKey: `${room.projectId}:${observedDeliveryId ?? observedNativeCliSessionId ?? ''}`
  });
  const observedBaseStream: NativeCliStreamView | undefined =
    observedStream ??
    (observation && observedNativeCliSessionId
      ? {
          id: observedNativeCliSessionId,
          agentName: observation.agentName ?? observationAccess?.nativeCliSessionId ?? 'Agent',
          provider: observationAccess?.provider ?? 'native-cli',
          tag: 'Agent',
          status: 'ok',
          output: '',
          items: []
        }
      : undefined);
  const shouldProjectObservationAccess =
    Boolean(observedDeliveryId) || observationAccess?.state !== 'history' || historyRequested;
  const observationProjection = shouldProjectObservationAccess
    ? observationProjectionFromAccess(observedBaseStream, observationAccess, observedDeliveryId)
    : undefined;
  const observedAccessStream = streamWithObservationProjection(observedBaseStream, observationProjection);
  const observedHistoryStream = streamWithHistoryPages(observedAccessStream, historyPages);
  const observedUsageAgentName = observedAccessStream?.templateAgentName;
  const usage = usePolledValue<NativeCliUsageResponse>({
    enabled: Boolean(observedUsageAgentName),
    intervalMs: observedAccessStream?.status === 'running' ? 15_000 : 0,
    load: () => triggerNativeCliUsage(observedUsageAgentName as string).unwrap(),
    resetKey: observedUsageAgentName ?? ''
  });
  const usageMeter = usageMeterFromObservationAccess({
    access: observationAccess,
    provider: observedAccessStream?.provider,
    stream: observedStream,
    usage
  });
  const observedAgent = observedRailAgent(observation, observedStream, room.railAgents);

  const loadHistoryPage = useCallback(
    (before?: string | null) => {
      if (!observedNativeCliSessionId) return;
      setHistoryPages((current) => {
        if (current?.loading) return current;
        return current
          ? { ...current, loading: true }
          : { items: [], nextCursor: null, loading: true, exhausted: false };
      });
      void triggerNativeCliHistoryPage({
        id: observedNativeCliSessionId,
        transcriptTargetId: room.projectId as TranscriptTargetId,
        before: before ?? undefined,
        limit: 20
      })
        .unwrap()
        .then(
          (response) => {
            // The daemon already knows this session's provider unambiguously and normalizes with the
            // same adapter it uses for parseOutput/historyPageOutput — no client-side re-derivation.
            const pageItems = response.events;
            setHistoryPages((current) => {
              const existing = current?.items ?? [];
              const nextItems = before
                ? mergeObservationItems(pageItems, existing)
                : mergeObservationItems(pageItems, []);
              return {
                items: nextItems,
                nextCursor: response.nextCursor ?? null,
                loading: false,
                exhausted: !response.nextCursor || pageItems.length === 0
              };
            });
          },
          () => {
            setHistoryPages((current) => ({
              items: current?.items ?? [],
              nextCursor: current?.nextCursor ?? null,
              loading: false,
              exhausted: true
            }));
          }
        );
    },
    [observedNativeCliSessionId, room.projectId, triggerNativeCliHistoryPage]
  );

  const showHistory = useCallback(() => {
    if (historyRequested || !observedNativeCliSessionId) return;
    setHistoryRequested(true);
    loadHistoryPage(null);
  }, [historyRequested, loadHistoryPage, observedNativeCliSessionId]);

  useEffect(() => {
    void observationHistoryResetKey;
    setHistoryPages(undefined);
    setHistoryRequested(false);
  }, [observationHistoryResetKey]);

  useEffect(() => {
    const storedWidth = window.localStorage.getItem(RAIL_WIDTH_STORAGE_KEY);
    if (!storedWidth) return;
    const nextWidth = Number.parseInt(storedWidth, 10);
    if (Number.isFinite(nextWidth)) setRailWidth(clampRailWidth(nextWidth));
  }, []);

  const setMeasuredRailWidth = useCallback((width: number) => {
    const nextWidth = clampRailWidth(width);
    setRailWidth(nextWidth);
    window.localStorage.setItem(RAIL_WIDTH_STORAGE_KEY, String(nextWidth));
  }, []);

  const beginResize = useCallback(
    ({
      cancelEvent,
      clientX,
      moveEvent,
      upEvent
    }: {
      cancelEvent?: 'pointercancel';
      clientX: number;
      moveEvent: 'mousemove' | 'pointermove';
      upEvent: 'mouseup' | 'pointerup';
    }) => {
      dragStartRef.current = { pointerX: clientX, width: effectiveRailWidth };
      setResizing(true);

      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.documentElement.dataset.sidebarResizing = 'true';

      const onResizeMove = (resizeEvent: MouseEvent | PointerEvent) => {
        setMeasuredRailWidth(dragStartRef.current.width + dragStartRef.current.pointerX - resizeEvent.clientX);
      };
      const onResizeEnd = () => {
        setResizing(false);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        delete document.documentElement.dataset.sidebarResizing;
        window.removeEventListener(moveEvent, onResizeMove);
        window.removeEventListener(upEvent, onResizeEnd);
        if (cancelEvent) window.removeEventListener(cancelEvent, onResizeEnd);
      };

      window.addEventListener(moveEvent, onResizeMove);
      window.addEventListener(upEvent, onResizeEnd);
      if (cancelEvent) window.addEventListener(cancelEvent, onResizeEnd);
    },
    [effectiveRailWidth, setMeasuredRailWidth]
  );

  const onResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLHRElement>) => {
      event.preventDefault();
      suppressMouseResizeRef.current = true;
      window.setTimeout(() => {
        suppressMouseResizeRef.current = false;
      }, 0);
      beginResize({
        cancelEvent: 'pointercancel',
        clientX: event.clientX,
        moveEvent: 'pointermove',
        upEvent: 'pointerup'
      });
    },
    [beginResize]
  );

  const onResizeMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLHRElement>) => {
      if (event.button !== 0 || suppressMouseResizeRef.current) return;
      event.preventDefault();
      beginResize({ clientX: event.clientX, moveEvent: 'mousemove', upEvent: 'mouseup' });
    },
    [beginResize]
  );

  const onResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLHRElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End')
        return;
      event.preventDefault();
      if (event.key === 'Home') setMeasuredRailWidth(MIN_RAIL_WIDTH);
      else if (event.key === 'End') setMeasuredRailWidth(MAX_RAIL_WIDTH);
      else setMeasuredRailWidth(effectiveRailWidth + (event.key === 'ArrowLeft' ? 12 : -12));
    },
    [effectiveRailWidth, setMeasuredRailWidth]
  );

  const observeAgent = useCallback(
    (agent: Participant) => {
      observeProjectAgent(room.projectId, { agentId: agent.id, agentName: agent.name });
    },
    [observeProjectAgent, room.projectId]
  );

  const renderAgent = (agent: Participant) => {
    const productIcon = resolveProductIcon(agent);
    const active = isActiveRailAgent(agent);
    const phase = active ? agentActivityPhaseMeta(agent) : null;
    const PhaseIcon = phase?.icon;
    return (
      <button
        aria-label={phase ? `Observe ${agent.name}, ${phase.label}` : `Observe ${agent.name}`}
        aria-pressed={observedAgent?.id === agent.id}
        className="workplace-action workplace-agent-status-row"
        data-selected={observedAgent?.id === agent.id}
        key={agent.id}
        onClick={() => observeAgent(agent)}
        style={{ '--agent-presence-color': presenceColor(agent.presence) } as CSSProperties}
        type="button"
      >
        <span
          className="workplace-agent-status-avatar"
          data-active={active ? 'true' : undefined}
        >
          <AgentInstanceAvatar
            agent={agent}
            bordered={active}
            size={28}
          />
          {phase && PhaseIcon ? (
            <span
              className="workplace-agent-status-phase"
              data-phase={agent.activityPhase}
              title={phase.label}
            >
              <HugeiconsIcon
                aria-hidden="true"
                icon={PhaseIcon}
                size={10}
                strokeWidth={2.4}
              />
            </span>
          ) : null}
        </span>
        <AgentIdentity
          badge={
            productIcon ? (
              <ProductIcon
                product={productIcon}
                size={12}
                title={agent.tag}
              />
            ) : null
          }
          className="workplace-agent-status-name"
          name={agent.name}
        />
      </button>
    );
  };

  return (
    <div
      className="scwf-scroll workplace-agent-rail"
      data-resizing={resizing}
      style={{
        width: effectiveRailWidth,
        flex: 'none',
        borderLeft: `1px solid ${'var(--sidebar-border)'}`,
        background: 'var(--sidebar)',
        minHeight: 0,
        overflow: 'visible',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative'
      }}
    >
      <style>{agentStatusRingCss}</style>
      <hr
        aria-label={t('web.workplace.resizeProjectSidebar')}
        aria-orientation="vertical"
        aria-valuemax={MAX_RAIL_WIDTH}
        aria-valuemin={MIN_RAIL_WIDTH}
        aria-valuenow={effectiveRailWidth}
        className="workplace-agent-rail-resize-handle"
        data-preserve-cursor="true"
        onKeyDown={onResizeKeyDown}
        onMouseDown={onResizeMouseDown}
        onPointerDown={onResizePointerDown}
        tabIndex={0}
      />
      {observation ? (
        <NativeCliObservationPanel
          agent={observedAgent}
          agentName={observedAgent?.name ?? observation.agentName}
          canLoadOlderHistory={
            historyRequested && Boolean(historyPages?.nextCursor) && !historyPages?.loading && !historyPages?.exhausted
          }
          focusTurnId={observation.turnId}
          icon={observedAgent?.icon ?? observedHistoryStream?.icon}
          loadingOlderHistory={historyPages?.loading}
          onBack={closeRailObservation}
          onLoadOlderHistory={() => loadHistoryPage(historyPages?.nextCursor)}
          onShowHistory={showHistory}
          onStop={(id) => void room.stopNativeCli(id)}
          showHistoryButton={!historyRequested && Boolean(observedNativeCliSessionId)}
          stream={observedHistoryStream}
          usageMeter={usageMeter}
        />
      ) : (
        <>
          <div style={{ ...sectionLabel, padding: '13px 15px 8px' }}>Monad Runtime</div>
          <div
            className="scwf-scroll"
            style={{
              padding: '0 14px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              borderBottom: `1px solid ${'var(--sidebar-border)'}`,
              flex: 'none',
              maxHeight: '42%',
              overflowY: 'auto'
            }}
          >
            {groups.active.length === 0 ? (
              <div
                style={{
                  fontFamily: sans,
                  fontSize: 13,
                  color: 'var(--sidebar-foreground)',
                  padding: '2px 0',
                  lineHeight: 1.5,
                  opacity: 0.6
                }}
              >
                {t('web.workplace.noActiveAgents')}
              </div>
            ) : null}
            {groups.active.map(renderAgent)}
          </div>

          <div style={{ ...sectionLabel, padding: '13px 15px 8px' }}>Monad Mesh</div>
          <div
            className="scwf-scroll"
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              padding: '0 14px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 8
            }}
          >
            {groups.standBy.length === 0 ? (
              <div
                style={{
                  fontFamily: sans,
                  fontSize: 13,
                  color: 'var(--sidebar-foreground)',
                  padding: '2px 0',
                  lineHeight: 1.5,
                  opacity: 0.6
                }}
              >
                {t('web.workplace.noStandByAgents')}
              </div>
            ) : null}
            {groups.standBy.map(renderAgent)}
          </div>
        </>
      )}
    </div>
  );
}
