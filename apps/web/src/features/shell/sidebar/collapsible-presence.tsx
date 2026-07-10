'use client';

import type { CSSProperties, ReactNode } from 'react';

import { cn } from '@monad/ui';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

type CollapsiblePresenceStyle = CSSProperties & {
  '--sidebar-collapse-height': string;
};

const COLLAPSE_HEIGHT_BUFFER = 6;

export function CollapsiblePresence({
  children,
  className,
  collapsed
}: {
  children: ReactNode;
  className?: string;
  collapsed: boolean;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);
  const [motionReady, setMotionReady] = useState(false);

  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!node) return;

    const measure = () => setHeight(node.scrollHeight + COLLAPSE_HEIGHT_BUFFER);
    measure();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setMotionReady(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const style: CollapsiblePresenceStyle = {
    '--sidebar-collapse-height': `${height}px`
  };

  return (
    <div
      aria-hidden={collapsed}
      className={cn(
        'overflow-hidden motion-reduce:transition-none',
        motionReady
          ? 'transition-[max-height,opacity,visibility] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]'
          : 'transition-none',
        collapsed
          ? 'invisible max-h-0 opacity-0'
          : motionReady
            ? 'visible max-h-[var(--sidebar-collapse-height)] opacity-100'
            : 'visible max-h-none opacity-100',
        className
      )}
      inert={collapsed}
      style={style}
    >
      <div ref={contentRef}>{children}</div>
    </div>
  );
}
