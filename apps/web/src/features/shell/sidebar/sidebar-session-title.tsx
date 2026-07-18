import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';

import { useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  getSidebarSessionTitleMotion,
  SIDEBAR_SESSION_TITLE_DELAY_MS,
  SIDEBAR_SESSION_TITLE_FADE_PX,
  type SidebarSessionTitleMotion
} from './sidebar-session-title-motion';

type MarqueePhase = 'idle' | 'moving' | 'settled';

const IDLE_MOTION: SidebarSessionTitleMotion = {
  distancePx: 0,
  durationMs: 0,
  overflowing: false
};

export function SidebarSessionTitle({
  actionWidth,
  disabled,
  label
}: {
  actionWidth: number;
  disabled: boolean;
  label: string;
}) {
  const prefersReducedMotion = useReducedMotion();
  const viewportRef = useRef<HTMLSpanElement | null>(null);
  const titleRef = useRef<HTMLSpanElement | null>(null);
  const intentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hovered, setHovered] = useState(false);
  const [motion, setMotion] = useState<SidebarSessionTitleMotion>(IDLE_MOTION);
  const [phase, setPhase] = useState<MarqueePhase>('idle');

  const clearIntentTimer = useCallback(() => {
    if (intentTimerRef.current === null) return;
    clearTimeout(intentTimerRef.current);
    intentTimerRef.current = null;
  }, []);

  const readMotion = useCallback(() => {
    const viewport = viewportRef.current;
    const title = titleRef.current;
    if (!viewport || !title) return IDLE_MOTION;
    return getSidebarSessionTitleMotion({
      actionWidth,
      titleWidth: title.scrollWidth,
      viewportWidth: viewport.clientWidth
    });
  }, [actionWidth]);

  const reset = useCallback(() => {
    clearIntentTimer();
    setHovered(false);
    setMotion(IDLE_MOTION);
    setPhase('idle');
  }, [clearIntentTimer]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const title = titleRef.current;
    if (!viewport || !title) return;

    const observer = new ResizeObserver(() => {
      clearIntentTimer();
      setMotion(IDLE_MOTION);
      setPhase('idle');
    });
    observer.observe(viewport);
    observer.observe(title);
    return () => observer.disconnect();
  }, [clearIntentTimer]);

  useEffect(() => {
    if (disabled) reset();
  }, [disabled, reset]);
  useEffect(() => () => clearIntentTimer(), [clearIntentTimer]);

  const startIntent = useCallback(
    (_event: ReactPointerEvent<HTMLSpanElement>) => {
      setHovered(true);
      clearIntentTimer();
      if (disabled || prefersReducedMotion) return;

      intentTimerRef.current = setTimeout(() => {
        intentTimerRef.current = null;
        const nextMotion = readMotion();
        setMotion(nextMotion);
        if (nextMotion.overflowing) setPhase('moving');
      }, SIDEBAR_SESSION_TITLE_DELAY_MS);
    },
    [clearIntentTimer, disabled, prefersReducedMotion, readMotion]
  );

  const occludedWidth = hovered ? Math.max(0, actionWidth) : 0;
  const maskImage = useMemo(() => {
    const fadeStart = occludedWidth + SIDEBAR_SESSION_TITLE_FADE_PX;
    const rightEdge = Math.max(0, occludedWidth);
    const leftStops = phase === 'idle' ? '#000 0' : `transparent 0, #000 ${SIDEBAR_SESSION_TITLE_FADE_PX}px`;
    return `linear-gradient(to right, ${leftStops}, #000 calc(100% - ${fadeStart}px), transparent calc(100% - ${rightEdge}px), transparent 100%)`;
  }, [occludedWidth, phase]);
  const displaced = phase === 'moving' || phase === 'settled';
  const trackStyle: CSSProperties = {
    transform: displaced ? `translate3d(-${motion.distancePx}px, 0, 0)` : 'translate3d(0, 0, 0)',
    transition: phase === 'moving' ? `transform ${motion.durationMs}ms linear` : 'none'
  };

  return (
    <span
      className="block min-w-0 overflow-hidden"
      data-sidebar-session-title-viewport="true"
      onPointerEnter={startIntent}
      onPointerLeave={reset}
      ref={viewportRef}
      style={{ maskImage, WebkitMaskImage: maskImage }}
    >
      <span
        className="block w-max whitespace-nowrap will-change-transform"
        data-marquee-state={phase}
        data-sidebar-session-title-track="true"
        onTransitionEnd={(event) => {
          if (event.propertyName === 'transform' && phase === 'moving') setPhase('settled');
        }}
        ref={titleRef}
        style={trackStyle}
      >
        {label}
      </span>
    </span>
  );
}
