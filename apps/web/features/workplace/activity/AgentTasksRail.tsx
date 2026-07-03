import type {
  NativeAgentDeliveryId,
  NativeAgentObservationProjection,
  NativeCliObservationAccessResponse,
  NativeCliUsageResponse,
  TranscriptTargetId
} from '@monad/protocol';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent
} from 'react';
import type { NativeCliUsageLimitMeter } from '../native-cli-observation';
import type { NativeCliStreamView, Participant } from '../types';

import { BrainIcon, EyeIcon, MegaphoneIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  skipToken,
  useGetNativeAgentDeliveryObservationQuery,
  useGetNativeCliObservationQuery,
  useGetNativeCliUsageQuery
} from '@monad/client-rtk';
import { nativeAgentObservationProjectionSchema } from '@monad/protocol';
import { ProductIcon } from '@monad/ui';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { AgentIdentity, AgentInstanceAvatar, resolveProductIcon } from '../Bits';
import { NativeCliObservationPanel } from '../cli/NativeCliStreamModal';
import {
  nativeCliStreamItems,
  nativeCliUsageLimitMeter,
  nativeCliUsageLimitMeterFromResponse
} from '../native-cli-observation';
import { presenceColor, sans, sectionLabel } from '../styles';
import { useWorkplaceUiStore } from '../workplace-ui-store';

const RAIL_WIDTH_STORAGE_KEY = 'monad.workplace.agentRail.width';
const DEFAULT_RAIL_WIDTH = 296;
const MIN_RAIL_WIDTH = 260;
const MAX_RAIL_WIDTH = 620;

function clampRailWidth(width: number): number {
  return Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, Math.round(width)));
}

export function agentObservationStream(
  observation:
    | {
        agentId?: string;
        agentName?: string;
        deliveryId?: NativeAgentDeliveryId;
        nativeCliSessionId?: string;
      }
    | null
    | undefined,
  streams: readonly NativeCliStreamView[]
) {
  if (!observation) return undefined;
  if (observation.nativeCliSessionId) {
    return streams.find((stream) => stream.id === observation.nativeCliSessionId);
  }
  const names = [observation.agentId, observation.agentName].filter((value): value is string => Boolean(value));
  if (names.length === 0) return undefined;
  const matchesAgent = (stream: NativeCliStreamView) => names.includes(stream.agentName);
  return (
    streams.find((stream) => matchesAgent(stream) && stream.status === 'running') ??
    streams.find((stream) => matchesAgent(stream))
  );
}

export function observedRailAgent(
  observation:
    | {
        agentId?: string;
        agentName?: string;
        deliveryId?: NativeAgentDeliveryId;
        nativeCliSessionId?: string;
      }
    | null
    | undefined,
  observedStream: NativeCliStreamView | undefined,
  agents: readonly Participant[]
): Participant | undefined {
  if (!observation) return undefined;
  const streamAgentName = observedStream?.agentName;
  return (
    agents.find((agent) => agent.id === observation.agentId) ??
    agents.find((agent) => agent.id === streamAgentName) ??
    agents.find((agent) => agent.name === observation.agentName) ??
    agents.find((agent) => agent.name === streamAgentName)
  );
}

function isActiveRailAgent(agent: Participant): boolean {
  return agent.presence === 'working';
}

function agentActivityPhaseMeta(agent: Participant): {
  label: string;
  icon: typeof EyeIcon;
} {
  if (agent.activityPhase === 'reading') return { label: 'Reading', icon: EyeIcon };
  if (agent.activityPhase === 'speaking') return { label: 'Speaking', icon: MegaphoneIcon };
  return { label: 'Thinking', icon: BrainIcon };
}

export function observationProjectionFromAccess(
  stream: NativeCliStreamView | undefined,
  access: NativeCliObservationAccessResponse | undefined,
  deliveryId?: NativeAgentDeliveryId
): NativeAgentObservationProjection | undefined {
  if (!stream || !access) return undefined;
  const projectedDeliveryId = access.deliveryId ?? deliveryId;
  if (access.state === 'unavailable') {
    return nativeAgentObservationProjectionSchema.parse({
      state: 'unavailable',
      nativeCliSessionId: stream.id,
      ...(projectedDeliveryId ? { deliveryId: projectedDeliveryId } : {}),
      ...(access.turn ? { turn: access.turn } : {}),
      provider: access.provider,
      reason: access.reason
    });
  }
  return nativeAgentObservationProjectionSchema.parse({
    state: access.state,
    nativeCliSessionId: stream.id,
    ...(projectedDeliveryId ? { deliveryId: projectedDeliveryId } : {}),
    ...(access.turn ? { turn: access.turn } : {}),
    provider: access.provider,
    observedAt: access.observedAt,
    events: nativeCliStreamItems({
      id: stream.id,
      provider: access.provider,
      output: access.output,
      observedAt: access.observedAt
    })
  });
}

export function streamWithObservationProjection(
  stream: NativeCliStreamView | undefined,
  projection: NativeAgentObservationProjection | undefined
): NativeCliStreamView | undefined {
  if (!stream || !projection) return stream;
  if (projection.state === 'unavailable') return { ...stream, output: '', items: [] };
  return {
    ...stream,
    output: projection.events.map((event) => event.text).join('\n\n'),
    items: projection.events
  };
}

export function usageMeterFromObservationAccess(args: {
  access?: NativeCliObservationAccessResponse;
  provider?: NativeCliStreamView['provider'];
  stream?: NativeCliStreamView;
  usage?: NativeCliUsageResponse;
}): NativeCliUsageLimitMeter | null {
  const sourceOutput = args.access && args.access.state !== 'unavailable' ? args.access.output : args.stream?.output;
  return (
    nativeCliUsageLimitMeterFromResponse(args.usage) ??
    nativeCliUsageLimitMeter({ output: sourceOutput, provider: args.provider ?? args.stream?.provider })
  );
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

export function groupProjectRailAgents(agents: readonly Participant[]): {
  active: Participant[];
  standBy: Participant[];
} {
  const active: Participant[] = [];
  const standBy: Participant[] = [];
  for (const agent of agents) {
    if (isActiveRailAgent(agent)) active.push(agent);
    else standBy.push(agent);
  }
  return { active, standBy };
}

type AgentTasksRailRoom = {
  nativeCliStreams: NativeCliStreamView[];
  projectId: string;
  railAgents: Participant[];
  stopNativeCli: (id: string) => void;
};

export function AgentTasksRail({ room }: { room: AgentTasksRailRoom }): React.ReactElement {
  const t = useT();
  const [railWidth, setRailWidth] = useState(DEFAULT_RAIL_WIDTH);
  const [resizing, setResizing] = useState(false);
  const dragStartRef = useRef({ pointerX: 0, width: DEFAULT_RAIL_WIDTH });
  const suppressMouseResizeRef = useRef(false);
  const effectiveRailWidth = railWidth;
  const observation = useWorkplaceUiStore((state) =>
    state.railObservation?.projectId === room.projectId ? state.railObservation : null
  );
  const observeProjectAgent = useWorkplaceUiStore((state) => state.observeProjectAgent);
  const closeRailObservation = useWorkplaceUiStore((state) => state.closeRailObservation);
  const groups = groupProjectRailAgents(room.railAgents);
  const observedStream = agentObservationStream(observation, room.nativeCliStreams);
  const observedStreamId = observedStream?.id;
  const observedDeliveryId = observation?.deliveryId;
  const observationPollMs = observedStream?.status === 'running' ? 900 : 0;
  const deliveryObservationAccessQuery = useGetNativeAgentDeliveryObservationQuery(
    observedDeliveryId
      ? { id: observedDeliveryId, transcriptTargetId: room.projectId as TranscriptTargetId }
      : skipToken,
    {
      pollingInterval: observationPollMs
    }
  );
  const observationAccessQuery = useGetNativeCliObservationQuery(
    observedStreamId && !observedDeliveryId
      ? { id: observedStreamId, transcriptTargetId: room.projectId as TranscriptTargetId }
      : skipToken,
    {
      pollingInterval: observationPollMs
    }
  );
  const observationAccess = deliveryObservationAccessQuery.data ?? observationAccessQuery.data;
  const observationProjection = observationProjectionFromAccess(observedStream, observationAccess, observedDeliveryId);
  const observedAccessStream = streamWithObservationProjection(observedStream, observationProjection);
  const observedUsageAgentName = observedAccessStream?.templateAgentName;
  const usageQuery = useGetNativeCliUsageQuery(observedUsageAgentName ?? skipToken, {
    pollingInterval: observedAccessStream?.status === 'running' ? 15_000 : 0
  });
  const usageMeter = usageMeterFromObservationAccess({
    access: observationAccess,
    provider: observedAccessStream?.provider,
    stream: observedStream,
    usage: usageQuery.data
  });
  const observedAgent = observedRailAgent(observation, observedStream, room.railAgents);

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
          focusTurnId={observation.turnId}
          icon={observedAgent?.icon ?? observedAccessStream?.icon}
          onBack={closeRailObservation}
          onStop={(id) => void room.stopNativeCli(id)}
          stream={observedAccessStream}
          usageMeter={usageMeter}
        />
      ) : (
        <>
          <div style={{ ...sectionLabel, padding: '13px 15px 8px' }}>{t('web.workplace.active')}</div>
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

          <div style={{ ...sectionLabel, padding: '13px 15px 8px' }}>{t('web.workplace.standBy')}</div>
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
