import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent
} from 'react';
import type { NativeCliStreamView, Participant } from '../types';
import type { ProjectController } from '../use-project';

import { ProductIcon } from '@monad/ui';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AgentIdentity, AgentInstanceAvatar, resolveProductIcon } from '../Bits';
import { NativeCliObservationPanel } from '../cli/NativeCliStreamModal';
import { presenceColor, sans, sectionLabel } from '../styles';
import { useWorkplaceUiStore } from '../workplace-ui-store';

const RAIL_WIDTH_STORAGE_KEY = 'monad.workplace.agentRail.width';
const DEFAULT_RAIL_WIDTH = 296;
const MIN_RAIL_WIDTH = 260;
const MAX_RAIL_WIDTH = 620;

function clampRailWidth(width: number): number {
  return Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, Math.round(width)));
}

function agentLatestStream(agentName: string | undefined, streams: readonly NativeCliStreamView[]) {
  if (!agentName) return undefined;
  return (
    streams.find((stream) => stream.agentName === agentName && stream.status === 'running') ??
    streams.find((stream) => stream.agentName === agentName)
  );
}

function isActiveRailAgent(agent: Participant): boolean {
  return agent.presence === 'working';
}

const agentStatusRingCss = `
@keyframes workplace-agent-status-breathe {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--agent-presence-color) 34%, transparent); }
  50% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--agent-presence-color) 0%, transparent); }
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
  .workplace-agent-status-avatar {
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

export function AgentTasksRail({ room }: { room: ProjectController }): React.ReactElement {
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
  const observedStream = observation?.nativeCliSessionId
    ? room.nativeCliStreams.find((stream) => stream.id === observation.nativeCliSessionId)
    : agentLatestStream(observation?.agentName, room.nativeCliStreams);
  const observedAgent = observation
    ? (room.railAgents.find((agent) => agent.id === observation.agentId) ??
      room.railAgents.find((agent) => agent.name === (observation.agentName ?? observedStream?.agentName)))
    : undefined;

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
    return (
      <button
        aria-label={`Observe ${agent.name}`}
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
          data-active={isActiveRailAgent(agent) ? 'true' : undefined}
        >
          <AgentInstanceAvatar
            agent={agent}
            bordered={isActiveRailAgent(agent)}
            size={28}
          />
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
        aria-label="Resize project sidebar"
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
        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr) auto' }}>
          <NativeCliObservationPanel
            agent={observedAgent}
            agentName={observedAgent?.name ?? observation.agentName}
            icon={observedAgent?.icon ?? observedStream?.icon}
            onBack={closeRailObservation}
            onStop={(id) => void room.stopNativeCli(id)}
            stream={observedStream}
          />
        </div>
      ) : (
        <>
          <div style={{ ...sectionLabel, padding: '13px 15px 8px' }}>ACTIVE</div>
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
                No active agents.
              </div>
            ) : null}
            {groups.active.map(renderAgent)}
          </div>

          <div style={{ ...sectionLabel, padding: '13px 15px 8px' }}>STAND-BY</div>
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
                No stand-by agents.
              </div>
            ) : null}
            {groups.standBy.map(renderAgent)}
          </div>
        </>
      )}
    </div>
  );
}
