import type { RefObject } from 'react';
import type { SidebarPagerSurface } from './sidebar-trackpad-switch';

import { animate, useMotionValue, useTransform } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import {
  createSidebarPagerGesture,
  FRESH_PUSH_REVERSE_MIN_PX,
  resolveSidebarPagerTarget,
  sidebarPageTurnThresholdPx,
  sidebarTrackpadEdgeAccum,
  sidebarTrackpadEdgeOffset
} from './sidebar-trackpad-switch';

const TRACKPAD_GESTURE_RELEASE_MS = 96;
// How long a surface-changing page turn suppresses its own inertia tail. Short enough to
// stay responsive to a deliberate second swipe, long enough to eat the strong part of the
// momentum so one flick can't turn two pages (settings -> studio -> workspace).
const PAGE_TURN_LOCK_MS = 180;
const TRACKPAD_EDGE_MARGIN_PX = 12;
const PANEL_SNAP_SCROLL_DURATION_S = 0.16;
const PANEL_SNAP_SCROLL_EASE = [0.33, 1, 0.68, 1] as const;
const TRACKPAD_RELEASE_VELOCITY_PX_S = 1200;
const TRACKPAD_BOUNCE_TRANSLATE_RATIO = 0.3;
const TRACKPAD_BOUNCE_DEG_PER_PX = 0.09;
const TRACKPAD_BOUNCE_MAX_DEG = 28;

interface UseSidebarPagerGestureParams {
  activeSidebarPageIndex: number;
  activeSidebarSurface: SidebarPagerSurface;
  onCloseSettings: () => void;
  onOpenArchived: () => void;
  onOpenStudio: () => void;
  onOpenWorkspace: () => void;
  onToggleSettings: () => void;
  pagerSurfaces: SidebarPagerSurface[];
  prefersReducedMotion: boolean | null;
  resizingRef: RefObject<boolean>;
  settingsReturnSurface: SidebarPagerSurface;
  showSettings: boolean;
}

// Drives the sidebar's horizontal panel pager: trackpad wheel gesture recognition,
// programmatic page-turn animation, and the doorway-swing edge bounce. Isolated from
// SessionSidebar because it owns a self-contained wheel-event stream and a dozen refs
// that only make sense together.
export function useSidebarPagerGesture({
  activeSidebarPageIndex,
  activeSidebarSurface,
  onCloseSettings,
  onOpenArchived,
  onOpenStudio,
  onOpenWorkspace,
  onToggleSettings,
  pagerSurfaces,
  prefersReducedMotion,
  resizingRef,
  settingsReturnSurface,
  showSettings
}: UseSidebarPagerGestureParams) {
  const currentSidebarSurfaceRef = useRef<SidebarPagerSurface>(activeSidebarSurface);
  const panelScrollRef = useRef<HTMLDivElement | null>(null);
  const pagerGestureRef = useRef(createSidebarPagerGesture());
  const dragActiveRef = useRef(false);
  const dragOriginRef = useRef(0);
  const dragPxRef = useRef(0);
  // clientWidth/scrollWidth read once per gesture, not per wheel tick: reading them
  // after a same-tick scrollLeft write forces a synchronous layout (thrash) every
  // event, which is what was showing up as a slow rAF handler during the scroll.
  const gestureMetricsRef = useRef({ clientWidth: 0, scrollWidth: 0 });
  const trackpadFeedbackAnimationRef = useRef<{ stop: () => void } | null>(null);
  const panelScrollAnimationRef = useRef<{ stop: () => void; target: number } | null>(null);
  const previousShowSettingsRef = useRef(showSettings);
  const routeDrivenScrollClearTimerRef = useRef(0);
  const trackpadResetTimerRef = useRef(0);
  const trackpadFeedbackSampleRef = useRef({ time: 0, x: 0 });
  const trackpadFeedbackVelocityRef = useRef(0);
  const trackpadGestureActiveRef = useRef(false);
  // A single physical wheel gesture must yield at most one surface-changing page turn:
  // once it has, the momentum tail is swallowed until the fingers lift (a quiet gap),
  // so inertia can't turn a second page across the surface change it just triggered.
  const pageTurnConsumedRef = useRef(false);
  const pageTurnLockTimerRef = useRef(0);
  const pageTurnDeltaSignRef = useRef(0);
  const activePageIndexRef = useRef(activeSidebarPageIndex);

  const trackpadFeedback = useMotionValue(0);
  // The edge bounce reuses the snap transition's doorway pose: the pushed
  // panel swings out behind its hinge edge instead of merely translating.
  const trackpadBounceX = useTransform(trackpadFeedback, (value) => value * TRACKPAD_BOUNCE_TRANSLATE_RATIO);
  const trackpadBounceRotateY = useTransform(trackpadFeedback, (value) =>
    Math.max(-TRACKPAD_BOUNCE_MAX_DEG, Math.min(TRACKPAD_BOUNCE_MAX_DEG, value * TRACKPAD_BOUNCE_DEG_PER_PX))
  );
  const trackpadBounceOrigin = useTransform(trackpadFeedback, (value) => (value >= 0 ? '0% 50%' : '100% 50%'));

  const stopTrackpadFeedbackAnimation = useCallback(() => {
    trackpadFeedbackAnimationRef.current?.stop();
    trackpadFeedbackAnimationRef.current = null;
  }, []);

  const cancelGesture = useCallback(() => {
    window.clearTimeout(trackpadResetTimerRef.current);
    window.clearTimeout(pageTurnLockTimerRef.current);
    pageTurnConsumedRef.current = false;
    pagerGestureRef.current.reset();
    stopTrackpadFeedbackAnimation();
    trackpadFeedback.set(0);
    trackpadFeedbackSampleRef.current = { time: 0, x: 0 };
    trackpadFeedbackVelocityRef.current = 0;
    trackpadGestureActiveRef.current = false;
    dragActiveRef.current = false;
    dragPxRef.current = 0;
  }, [stopTrackpadFeedbackAnimation, trackpadFeedback]);

  const releaseTrackpadGesture = useCallback(() => {
    window.clearTimeout(trackpadResetTimerRef.current);
    trackpadGestureActiveRef.current = false;
    stopTrackpadFeedbackAnimation();
    if (prefersReducedMotion || trackpadFeedback.get() === 0) {
      trackpadFeedback.set(0);
      return;
    }
    trackpadFeedbackAnimationRef.current = animate(trackpadFeedback, 0, {
      type: 'spring',
      velocity: trackpadFeedbackVelocityRef.current,
      stiffness: 520,
      damping: 34,
      mass: 0.42
    });
  }, [prefersReducedMotion, stopTrackpadFeedbackAnimation, trackpadFeedback]);

  const closeSettingsWithPagerAnimation = useCallback(() => {
    const host = panelScrollRef.current;
    if (!host || !showSettings) {
      onCloseSettings();
      return;
    }
    panelScrollAnimationRef.current?.stop();
    window.clearTimeout(routeDrivenScrollClearTimerRef.current);
    const target = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(routeDrivenScrollClearTimerRef.current);
      onCloseSettings();
    };
    currentSidebarSurfaceRef.current = settingsReturnSurface;
    if (prefersReducedMotion || Math.abs(host.scrollLeft - target) <= 1) {
      host.scrollLeft = target;
      finish();
      return;
    }
    const closeEntry = {
      stop: () => {
        closeControls.stop();
        if (panelScrollAnimationRef.current === closeEntry) panelScrollAnimationRef.current = null;
      },
      target
    };
    const closeControls = animate(host.scrollLeft, target, {
      duration: PANEL_SNAP_SCROLL_DURATION_S,
      ease: PANEL_SNAP_SCROLL_EASE,
      onComplete: () => {
        if (panelScrollAnimationRef.current === closeEntry) panelScrollAnimationRef.current = null;
        finish();
      },
      onUpdate: (value) => {
        host.scrollLeft = value;
      }
    });
    panelScrollAnimationRef.current = closeEntry;
    routeDrivenScrollClearTimerRef.current = window.setTimeout(finish, PANEL_SNAP_SCROLL_DURATION_S * 1000 + 120);
  }, [onCloseSettings, prefersReducedMotion, settingsReturnSurface, showSettings]);

  useEffect(() => {
    currentSidebarSurfaceRef.current = activeSidebarSurface;
  }, [activeSidebarSurface]);

  // Keep the native scroll position in lockstep with the active sidebar surface, so
  // menu/shortcut-driven switches slide the panels the same way a swipe does.
  useLayoutEffect(() => {
    const host = panelScrollRef.current;
    if (!host) return;
    currentSidebarSurfaceRef.current = activeSidebarSurface;
    activePageIndexRef.current = activeSidebarPageIndex;
    const wasShowingSettings = previousShowSettingsRef.current;
    const enteringSettings = showSettings && !wasShowingSettings;
    const leavingSettings = !showSettings && wasShowingSettings;
    previousShowSettingsRef.current = showSettings;
    let retryFrame = 0;
    let retriesLeft = 20;
    const retry = () => {
      if (retriesLeft <= 0) return;
      retriesLeft -= 1;
      cancelAnimationFrame(retryFrame);
      retryFrame = requestAnimationFrame(sync);
    };
    // An instant scrollTo can silently miss during a route swap: clientWidth can
    // read 0 mid-relayout, scrollWidth can clamp the write while the new page
    // set hasn't laid out, and scroll anchoring can shift the position after the
    // children reorder. Any of those rests the pager on the wrong page while the
    // URL stays put (e.g. workspace panel shown on a studio route) — so verify
    // the write landed and retry after layout instead of trusting it.
    const settleInstant = (target: number) => {
      host.scrollTo({ behavior: 'instant' as ScrollBehavior, left: target });
      if (Math.abs(host.scrollLeft - target) > 1 && !dragActiveRef.current) retry();
    };
    const sync = () => {
      if (dragActiveRef.current || host.clientWidth === 0) {
        retry();
        return;
      }
      if (enteringSettings) host.scrollTo({ behavior: 'instant' as ScrollBehavior, left: 0 });
      const target = activeSidebarPageIndex * host.clientWidth;
      if (leavingSettings) {
        window.clearTimeout(routeDrivenScrollClearTimerRef.current);
        panelScrollAnimationRef.current?.stop();
        settleInstant(target);
        host.dataset.snapReady = 'true';
        return;
      }
      if (Math.abs(host.scrollLeft - target) <= 1) {
        host.dataset.snapReady = 'true';
        window.clearTimeout(routeDrivenScrollClearTimerRef.current);
        return;
      }
      // A gesture-driven page turn (finishPageTurn) already has a tween running to this
      // same target when its own surface-change setState re-renders us here. Restarting a
      // fresh tween mid-flight resets the ease-out curve and shows as a stutter right at
      // the settle — let the in-flight animation own the finish instead of pre-empting it.
      if (panelScrollAnimationRef.current && Math.abs(panelScrollAnimationRef.current.target - target) <= 1) {
        host.dataset.snapReady = 'true';
        return;
      }
      window.clearTimeout(routeDrivenScrollClearTimerRef.current);
      panelScrollAnimationRef.current?.stop();
      if (host.dataset.snapReady !== 'true' || prefersReducedMotion) {
        settleInstant(target);
      } else {
        // Browser smooth scrolling has a fixed, sluggish pace; drive scrollLeft
        // with a short ease-out tween so programmatic page turns feel crisp.
        const entry = {
          stop: () => {
            controls.stop();
            if (panelScrollAnimationRef.current === entry) panelScrollAnimationRef.current = null;
          },
          target
        };
        const controls = animate(host.scrollLeft, target, {
          duration: PANEL_SNAP_SCROLL_DURATION_S,
          ease: PANEL_SNAP_SCROLL_EASE,
          onComplete: () => {
            if (panelScrollAnimationRef.current === entry) panelScrollAnimationRef.current = null;
          },
          onUpdate: (value) => {
            host.scrollLeft = value;
          }
        });
        panelScrollAnimationRef.current = entry;
      }
      host.dataset.snapReady = 'true';
    };
    sync();
    return () => cancelAnimationFrame(retryFrame);
  }, [activeSidebarPageIndex, activeSidebarSurface, prefersReducedMotion, showSettings]);

  // Standing invariant guard: at rest (no drag, no tween) the pager must sit exactly on
  // the active surface's page — every legitimate write happens under one of those two
  // flags, so any other scroll (browser focus-reveal scrolling, scroll anchoring after
  // a children reorder, any engine-specific stray write) is illegitimate and reverted
  // SYNCHRONOUSLY inside its own scroll event. Scroll events dispatch during the
  // rendering steps before paint, so the wrong position is never shown — a deferred
  // correction here reads as the wrong panel flashing before snapping back. Reads the
  // expected index from a ref kept current by the route-sync layout effect, so the
  // guard never fights a same-commit surface change.
  useEffect(() => {
    const host = panelScrollRef.current;
    if (!host) return;
    const onScroll = () => {
      if (dragActiveRef.current || panelScrollAnimationRef.current) return;
      const width = host.clientWidth;
      if (!width) return;
      const target = activePageIndexRef.current * width;
      if (Math.abs(host.scrollLeft - target) > 1) host.scrollLeft = target;
    };
    host.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      host.removeEventListener('scroll', onScroll);
    };
  }, []);

  useEffect(
    () => () => {
      panelScrollAnimationRef.current?.stop();
      window.clearTimeout(routeDrivenScrollClearTimerRef.current);
    },
    []
  );

  useEffect(() => {
    const host = panelScrollRef.current;
    if (!host) return;

    const armPageTurnLock = () => {
      window.clearTimeout(pageTurnLockTimerRef.current);
      pageTurnLockTimerRef.current = window.setTimeout(() => {
        pageTurnConsumedRef.current = false;
      }, PAGE_TURN_LOCK_MS);
    };

    // Native scroll-snap is off: the release timing of the browser's snap
    // animation is not tunable and momentum bleeds into it. The pager owns the
    // whole horizontal stream — drag writes scrollLeft 1:1, release runs our
    // own short tween, and the momentum tail is swallowed.
    const finishPageTurn = (dragPxTotal: number) => {
      window.clearTimeout(trackpadResetTimerRef.current);
      dragActiveRef.current = false;
      dragPxRef.current = 0;
      // The same gesture already produced a surface-changing turn; ignore the inertia tail
      // so it can't turn a second page (e.g. settings -> studio -> workspace in one flick).
      if (pageTurnConsumedRef.current) {
        releaseTrackpadGesture();
        return;
      }
      const width = gestureMetricsRef.current.clientWidth || host.clientWidth || 1;
      const targetSurface = resolveSidebarPagerTarget({
        clientWidth: width,
        dragOrigin: dragOriginRef.current,
        dragPxTotal,
        pageCount: pagerSurfaces.length,
        scrollLeft: host.scrollLeft
      });
      const target = targetSurface * width;
      const targetSurfaceId = pagerSurfaces[targetSurface] ?? 'workspace';
      const closesSettings = showSettings && targetSurfaceId !== 'settings';
      const surfaceChanged = targetSurfaceId !== currentSidebarSurfaceRef.current;
      if (surfaceChanged) {
        pageTurnConsumedRef.current = true;
        pageTurnDeltaSignRef.current = Math.sign(dragPxTotal);
        armPageTurnLock();
        currentSidebarSurfaceRef.current = targetSurfaceId;
        if (!closesSettings) {
          if (targetSurfaceId === 'settings') onToggleSettings();
          if (targetSurfaceId === 'studio') onOpenStudio();
          if (targetSurfaceId === 'archived') onOpenArchived();
          if (targetSurfaceId === 'workspace') onOpenWorkspace();
        }
      }
      const finishSettingsClose = () => {
        if (closesSettings) onCloseSettings();
      };
      panelScrollAnimationRef.current?.stop();
      if (Math.abs(host.scrollLeft - target) > 1) {
        if (prefersReducedMotion) {
          host.scrollLeft = target;
          finishSettingsClose();
        } else {
          const turnEntry = {
            stop: () => {
              controls.stop();
              if (panelScrollAnimationRef.current === turnEntry) panelScrollAnimationRef.current = null;
            },
            target
          };
          const controls = animate(host.scrollLeft, target, {
            duration: PANEL_SNAP_SCROLL_DURATION_S,
            ease: PANEL_SNAP_SCROLL_EASE,
            onComplete: () => {
              if (panelScrollAnimationRef.current === turnEntry) panelScrollAnimationRef.current = null;
              finishSettingsClose();
            },
            onUpdate: (value) => {
              host.scrollLeft = value;
            }
          });
          panelScrollAnimationRef.current = turnEntry;
        }
      } else {
        finishSettingsClose();
      }
      releaseTrackpadGesture();
    };

    const finishFromTimer = () => {
      pagerGestureRef.current.swallowTail(performance.now(), 0);
      finishPageTurn(dragPxRef.current);
    };

    const onWheel = (event: WheelEvent) => {
      if (resizingRef.current) return;
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) {
        if (dragActiveRef.current) {
          window.clearTimeout(trackpadResetTimerRef.current);
          trackpadResetTimerRef.current = window.setTimeout(finishFromTimer, TRACKPAD_GESTURE_RELEASE_MS);
        }
        return;
      }

      event.preventDefault();
      // The gesture already turned its one page — swallow the rest of its inertia tail.
      // The tail can outlive any fixed delay by seconds, so each locked event re-arms the
      // lock (it lifts only after the stream quiets) AND refreshes the pager's swallow
      // window, so the moment the lock lifts the leftover tail cannot re-enter as a fresh
      // drag and turn a second page (settings -> studio -> workspace in one flick). A
      // clear direction reversal is the user pushing back — release the lock to it.
      if (pageTurnConsumedRef.current) {
        const reversed =
          pageTurnDeltaSignRef.current !== 0 &&
          Math.sign(event.deltaX) === -pageTurnDeltaSignRef.current &&
          Math.abs(event.deltaX) >= FRESH_PUSH_REVERSE_MIN_PX;
        if (!reversed) {
          pagerGestureRef.current.swallowTail(event.timeStamp, event.deltaX);
          armPageTurnLock();
          return;
        }
        window.clearTimeout(pageTurnLockTimerRef.current);
        pageTurnConsumedRef.current = false;
      }
      if (!dragActiveRef.current) {
        gestureMetricsRef.current = { clientWidth: host.clientWidth, scrollWidth: host.scrollWidth };
      }
      const edgeMaxPx = gestureMetricsRef.current.clientWidth + TRACKPAD_EDGE_MARGIN_PX;
      const seedPx = !dragActiveRef.current ? sidebarTrackpadEdgeAccum(trackpadFeedback.get(), edgeMaxPx) : 0;
      const result = pagerGestureRef.current.update({
        deltaX: event.deltaX,
        now: event.timeStamp,
        seedPx,
        settleThresholdPx: sidebarPageTurnThresholdPx(gestureMetricsRef.current.clientWidth)
      });
      if (result.kind === 'swallowed') return;
      if (result.kind === 'settle') {
        finishPageTurn(result.dragPx);
        return;
      }

      if (!dragActiveRef.current) {
        dragActiveRef.current = true;
        dragOriginRef.current = host.scrollLeft;
        panelScrollAnimationRef.current?.stop();
      }
      trackpadGestureActiveRef.current = true;
      dragPxRef.current = result.dragPx;
      window.clearTimeout(trackpadResetTimerRef.current);
      stopTrackpadFeedbackAnimation();

      const maxScroll = gestureMetricsRef.current.scrollWidth - gestureMetricsRef.current.clientWidth;
      const desired = dragOriginRef.current + result.dragPx;
      const clamped = Math.max(0, Math.min(maxScroll, desired));
      host.scrollLeft = clamped;
      const excess = desired - clamped;
      const nextFeedback = prefersReducedMotion || excess === 0 ? 0 : sidebarTrackpadEdgeOffset(excess, edgeMaxPx);
      const lastSample = trackpadFeedbackSampleRef.current;
      const elapsed = event.timeStamp - lastSample.time;
      if (elapsed > 0 && elapsed < 120) {
        const velocity = ((nextFeedback - lastSample.x) / elapsed) * 1000;
        trackpadFeedbackVelocityRef.current = Math.max(
          -TRACKPAD_RELEASE_VELOCITY_PX_S,
          Math.min(TRACKPAD_RELEASE_VELOCITY_PX_S, velocity)
        );
      } else {
        trackpadFeedbackVelocityRef.current = 0;
      }
      trackpadFeedbackSampleRef.current = { time: event.timeStamp, x: nextFeedback };
      trackpadFeedback.set(nextFeedback);
      trackpadResetTimerRef.current = window.setTimeout(finishFromTimer, TRACKPAD_GESTURE_RELEASE_MS);
    };

    host.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      host.removeEventListener('wheel', onWheel);
    };
  }, [
    onCloseSettings,
    onOpenArchived,
    onOpenStudio,
    onOpenWorkspace,
    onToggleSettings,
    pagerSurfaces,
    prefersReducedMotion,
    releaseTrackpadGesture,
    resizingRef,
    showSettings,
    stopTrackpadFeedbackAnimation,
    trackpadFeedback
  ]);

  useEffect(() => cancelGesture, [cancelGesture]);

  return {
    cancelGesture,
    closeSettingsWithPagerAnimation,
    panelScrollRef,
    style: {
      overscrollBehaviorX: 'contain' as const,
      rotateY: trackpadBounceRotateY,
      transformOrigin: trackpadBounceOrigin,
      transformPerspective: 1100,
      x: trackpadBounceX
    }
  };
}
