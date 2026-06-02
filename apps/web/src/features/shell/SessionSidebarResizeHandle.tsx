import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent
} from 'react';

interface SessionSidebarResizeHandleProps {
  label: string;
  max: number;
  min: number;
  onKeyDown: (event: ReactKeyboardEvent<HTMLHRElement>) => void;
  onMouseDown: (event: ReactMouseEvent<HTMLHRElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLHRElement>) => void;
  value: number;
}

export function SessionSidebarResizeHandle({
  label,
  max,
  min,
  onKeyDown,
  onMouseDown,
  onPointerDown,
  value
}: SessionSidebarResizeHandleProps) {
  return (
    <hr
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemax={max}
      aria-valuemin={min}
      aria-valuenow={value}
      className="panel-nav-resize-handle"
      data-preserve-cursor="true"
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
      onPointerDown={onPointerDown}
      tabIndex={0}
    />
  );
}
