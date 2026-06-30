import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent
} from 'react';
import type { ActivityStatus } from './types';
import type { ProjectController } from './use-project';

import { useCallback, useEffect, useRef, useState } from 'react';

import { Avatar, MiniTag, PresenceBadge } from './Bits';
import { boxR, mono, sans, sectionLabel } from './styles';
import { WorkOutput } from './WorkOutput';

const RAIL_WIDTH_STORAGE_KEY = 'monad.workplace.agentRail.width';
const DEFAULT_RAIL_WIDTH = 296;
const MIN_RAIL_WIDTH = 260;
const MAX_RAIL_WIDTH = 620;

function clampRailWidth(width: number): number {
  return Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, Math.round(width)));
}

function statusPill(status: ActivityStatus): CSSProperties {
  const color = status === 'ok' ? 'var(--success)' : status === 'error' ? 'var(--destructive)' : 'var(--accent-blue)';
  const background =
    status === 'ok'
      ? 'color-mix(in srgb, var(--success) 14%, transparent)'
      : status === 'error'
        ? 'color-mix(in srgb, var(--destructive) 14%, transparent)'
        : 'color-mix(in srgb, var(--accent-blue) 16%, transparent)';
  return {
    fontFamily: mono,
    fontSize: 9,
    color: 'var(--foreground)',
    border: `1px solid ${color}`,
    background,
    borderRadius: 5,
    padding: '1px 5px',
    flex: 'none',
    whiteSpace: 'nowrap'
  };
}

const statusText = (s: ActivityStatus): string => (s === 'ok' ? 'done' : s === 'error' ? 'error' : 'running');

export function AgentTasksRail({ room }: { room: ProjectController }): React.ReactElement {
  const [railWidth, setRailWidth] = useState(DEFAULT_RAIL_WIDTH);
  const [resizing, setResizing] = useState(false);
  const dragStartRef = useRef({ pointerX: 0, width: DEFAULT_RAIL_WIDTH });
  const suppressMouseResizeRef = useRef(false);
  const effectiveRailWidth = railWidth;

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

  return (
    <div
      className="scwf-scroll workplace-agent-rail"
      data-resizing={resizing}
      style={{
        width: effectiveRailWidth,
        flex: 'none',
        borderLeft: `1px solid ${'var(--border)'}`,
        background: 'var(--muted)',
        minHeight: 0,
        overflow: 'visible',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative'
      }}
    >
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
      <div style={{ ...sectionLabel, padding: '13px 15px 8px' }}>ACTIVE WORK</div>
      <div
        className="scwf-scroll"
        style={{
          padding: '0 14px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          borderBottom: `1px solid ${'var(--border)'}`,
          flex: 'none',
          maxHeight: '34%',
          overflowY: 'auto'
        }}
      >
        {room.tasks.length === 0 ? (
          <div
            style={{
              fontFamily: sans,
              fontSize: 13,
              color: 'var(--muted-foreground)',
              padding: '2px 0',
              lineHeight: 1.5
            }}
          >
            Agent tasks will appear here while work is running.
          </div>
        ) : null}
        {room.tasks.map((t) => (
          <div
            key={t.id}
            style={{
              border: `1px solid ${'var(--border)'}`,
              borderRadius: boxR,
              background: 'var(--card)',
              padding: '9px 10px',
              display: 'grid',
              gridTemplateColumns: '24px minmax(0, 1fr) auto',
              alignItems: 'start',
              gap: 8,
              boxShadow: 'none'
            }}
          >
            <span
              style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                border: `1px solid ${'var(--accent-blue)'}`,
                background: 'var(--accent-blue-soft)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: mono,
                fontSize: 9,
                flex: 'none'
              }}
            >
              {t.av}
            </span>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontFamily: sans,
                  fontSize: 14,
                  fontWeight: 500,
                  lineHeight: 1.35,
                  minWidth: 0,
                  wordBreak: 'break-word'
                }}
              >
                {t.title}
              </div>
              {t.output ? (
                <WorkOutput
                  maxHeight={150}
                  output={t.output}
                />
              ) : null}
            </div>
            <span style={statusPill(t.status)}>{statusText(t.status)}</span>
          </div>
        ))}
      </div>

      <div
        className="scwf-scroll"
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: 14 }}
      >
        <div style={{ ...sectionLabel, padding: '13px 15px 8px' }}>PARTICIPANTS</div>
        <div style={{ padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {room.participants.map((p) => (
            <div
              key={p.id}
              style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 0', minWidth: 0 }}
            >
              <div style={{ position: 'relative', flex: 'none' }}>
                <Avatar
                  av={p.av}
                  icon={p.icon}
                  kind={p.kind}
                  size={28}
                />
                <PresenceBadge presence={p.presence} />
              </div>
              <div
                style={{ fontFamily: sans, fontSize: 14, display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                {p.kind === 'agent' ? (
                  <MiniTag tag={p.tag} />
                ) : p.role ? (
                  <span
                    style={{ fontFamily: mono, fontSize: 9, color: 'var(--muted-foreground)', whiteSpace: 'nowrap' }}
                  >
                    · {p.role}
                  </span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
