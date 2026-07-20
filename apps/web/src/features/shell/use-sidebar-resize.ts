import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject
} from 'react';

import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_SIDEBAR_WIDTH = 288;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 420;
const SIDEBAR_WIDTH_STORAGE_KEY = 'monad:web:sidebar-width';

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

interface UseSidebarResizeParams {
  cancelPagerGesture: () => void;
  resizingRef: RefObject<boolean>;
}

export function useSidebarResize({ cancelPagerGesture, resizingRef }: UseSidebarResizeParams) {
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [resizing, setResizing] = useState(false);
  const dragStartRef = useRef({ pointerX: 0, width: DEFAULT_SIDEBAR_WIDTH });
  const suppressMouseResizeRef = useRef(false);

  useEffect(() => {
    const storedWidth = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (!storedWidth) return;
    const nextWidth = Number.parseInt(storedWidth, 10);
    if (Number.isFinite(nextWidth)) setSidebarWidth(clampSidebarWidth(nextWidth));
  }, []);

  // Synchronous localStorage writes are slow enough to blow the rAF budget when called
  // every drag frame (Chrome flags it as a "Violation"); persist only once, on release.
  const applySidebarWidth = useCallback((width: number) => {
    setSidebarWidth(clampSidebarWidth(width));
  }, []);

  const setMeasuredSidebarWidth = useCallback((width: number) => {
    const nextWidth = clampSidebarWidth(width);
    setSidebarWidth(nextWidth);
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(nextWidth));
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
      resizingRef.current = true;
      dragStartRef.current = { pointerX: clientX, width: sidebarWidth };
      cancelPagerGesture();
      setResizing(true);

      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.documentElement.dataset.sidebarResizing = 'true';

      let resizeFrame = 0;
      let latestClientX = clientX;
      const onResizeMove = (resizeEvent: MouseEvent | PointerEvent) => {
        latestClientX = resizeEvent.clientX;
        if (resizeFrame) return;
        resizeFrame = window.requestAnimationFrame(() => {
          resizeFrame = 0;
          applySidebarWidth(dragStartRef.current.width + latestClientX - dragStartRef.current.pointerX);
        });
      };
      const onResizeEnd = () => {
        if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
        resizeFrame = 0;
        resizingRef.current = false;
        setResizing(false);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        delete document.documentElement.dataset.sidebarResizing;
        window.removeEventListener(moveEvent, onResizeMove);
        window.removeEventListener(upEvent, onResizeEnd);
        if (cancelEvent) window.removeEventListener(cancelEvent, onResizeEnd);
        setMeasuredSidebarWidth(dragStartRef.current.width + latestClientX - dragStartRef.current.pointerX);
      };

      window.addEventListener(moveEvent, onResizeMove);
      window.addEventListener(upEvent, onResizeEnd);
      if (cancelEvent) window.addEventListener(cancelEvent, onResizeEnd);
    },
    [applySidebarWidth, cancelPagerGesture, resizingRef, setMeasuredSidebarWidth, sidebarWidth]
  );

  const onResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLHRElement>) => {
      event.preventDefault();
      event.stopPropagation();
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
      event.stopPropagation();
      beginResize({ clientX: event.clientX, moveEvent: 'mousemove', upEvent: 'mouseup' });
    },
    [beginResize]
  );

  const onResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLHRElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End')
        return;
      event.preventDefault();
      if (event.key === 'Home') setMeasuredSidebarWidth(MIN_SIDEBAR_WIDTH);
      else if (event.key === 'End') setMeasuredSidebarWidth(MAX_SIDEBAR_WIDTH);
      else setMeasuredSidebarWidth(sidebarWidth + (event.key === 'ArrowRight' ? 12 : -12));
    },
    [setMeasuredSidebarWidth, sidebarWidth]
  );

  return {
    maxSidebarWidth: MAX_SIDEBAR_WIDTH,
    minSidebarWidth: MIN_SIDEBAR_WIDTH,
    onResizeKeyDown,
    onResizeMouseDown,
    onResizePointerDown,
    resizing,
    sidebarWidth
  };
}
