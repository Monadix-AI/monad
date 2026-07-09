'use client';

import type { NetworkRuntimeStatus, SessionId } from '@monad/protocol';
import type { SettingsSectionId } from '#/features/settings/sections';
import type { StudioSectionId } from '#/features/studio/sections';
import type { RemoteDaemonConnection } from '#/lib/daemon-connections';

import { cn } from '@monad/ui';
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react';
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';

import { useT } from '#/components/I18nProvider';
import { ThemeToggle } from '#/components/ThemeToggle';
import { useWorkspaceShellStore } from '#/lib/workspace-shell-store';
import { DaemonMenu } from './SessionSidebarDaemonMenu';
import {
  type ProjectItem,
  SettingsSidebarItems,
  SidebarHeader,
  StudioSidebarItems,
  WorkspaceSidebarItems
} from './sidebar';
import {
  createSidebarPagerGesture,
  resolveSidebarPagerTarget,
  type SidebarPagerSurface,
  sidebarTrackpadEdgeAccum,
  sidebarTrackpadEdgeOffset
} from './sidebar-trackpad-switch';

interface Props {
  projects: ProjectItem[];
  hasUpgrade?: boolean;
  showSettings: boolean;
  showStudio: boolean;
  studioPileActive: boolean;
  workspacePileActive: boolean;
  monadChatActive: boolean;
  runtimeReady: boolean;
  activeProjectId: string | null;
  activeProjectSessionId: string | null;
  daemonBaseUrl: string;
  daemonStatus: 'checking' | 'online' | 'offline';
  daemonVersion?: string;
  networkRuntime?: NetworkRuntimeStatus;
  settingsReturnSurface: Exclude<SidebarPagerSurface, 'settings'>;
  settingsSection: SettingsSectionId;
  studioSection: StudioSectionId;
  shortcutModifierLabel?: string;
  showShortcutBadges?: boolean;
  onOpenWorkspace: () => void;
  onOpenMonadChat: () => void;
  onOpenProject: (id: string) => void;
  onOpenProjectSettings: (id: string) => void;
  onOpenProjectSession: (projectId: string, sessionId: SessionId) => void;
  onOpenSettingsSection: (section: SettingsSectionId) => void;
  onOpenStudio: () => void;
  onOpenStudioSection: (section: StudioSectionId) => void;
  onSwitchDaemonConnection: (
    request: { type: 'local' } | { connection: RemoteDaemonConnection; type: 'remote' }
  ) => void;
  onCloseSettings: () => void;
  onToggleSettings: () => void;
}

const DEFAULT_SIDEBAR_WIDTH = 288;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 420;
const SIDEBAR_WIDTH_STORAGE_KEY = 'monad:web:sidebar-width';
const AUTO_REVEAL_CLOSE_ANIMATION_MS = 200;
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

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

export function SessionSidebar({
  projects,
  hasUpgrade,
  showSettings,
  showStudio,
  studioPileActive,
  workspacePileActive,
  monadChatActive,
  runtimeReady,
  activeProjectId,
  activeProjectSessionId,
  daemonBaseUrl,
  daemonStatus,
  daemonVersion,
  networkRuntime,
  settingsReturnSurface,
  settingsSection,
  studioSection,
  shortcutModifierLabel = '⌘',
  showShortcutBadges,
  onOpenWorkspace,
  onOpenMonadChat,
  onOpenProject,
  onOpenProjectSettings,
  onOpenProjectSession,
  onOpenSettingsSection,
  onOpenStudio,
  onOpenStudioSection,
  onSwitchDaemonConnection,
  onCloseSettings,
  onToggleSettings
}: Props) {
  const t = useT();
  const collapsed = useWorkspaceShellStore((state) => state.sidebarCollapsed);
  const overlay = useWorkspaceShellStore((state) => state.sidebarAutoReveal);
  const collapseSidebar = useWorkspaceShellStore((state) => state.collapseSidebar);
  const revealSidebar = useWorkspaceShellStore((state) => state.revealSidebar);
  const toggleProjectPinned = useWorkspaceShellStore((state) => state.toggleProjectPinned);
  const toggleSidebarCollapsed = useWorkspaceShellStore((state) => state.toggleSidebarCollapsed);
  const autoCollapseOnPointerLeave = overlay;
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [resizing, setResizing] = useState(false);
  const [autoRevealClosing, setAutoRevealClosing] = useState(false);
  const currentSidebarSurfaceRef = useRef<SidebarPagerSurface>(showStudio ? 'studio' : 'workspace');
  const sidebarRef = useRef<HTMLElement | null>(null);
  const panelScrollRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef({ pointerX: 0, width: DEFAULT_SIDEBAR_WIDTH });
  const pagerGestureRef = useRef(createSidebarPagerGesture());
  const dragActiveRef = useRef(false);
  const dragOriginRef = useRef(0);
  const dragPxRef = useRef(0);
  const trackpadFeedbackAnimationRef = useRef<{ stop: () => void } | null>(null);
  const panelScrollAnimationRef = useRef<{ stop: () => void } | null>(null);
  const previousShowSettingsRef = useRef(showSettings);
  const routeDrivenScrollClearTimerRef = useRef(0);
  const autoRevealCloseTimerRef = useRef(0);
  const resizingRef = useRef(false);
  const trackpadResetTimerRef = useRef(0);
  const trackpadFeedbackSampleRef = useRef({ time: 0, x: 0 });
  const trackpadFeedbackVelocityRef = useRef(0);
  const trackpadGestureActiveRef = useRef(false);
  // A single physical wheel gesture must yield at most one surface-changing page turn:
  // once it has, the momentum tail is swallowed until the fingers lift (a quiet gap),
  // so inertia can't turn a second page across the surface change it just triggered.
  const pageTurnConsumedRef = useRef(false);
  const pageTurnLockTimerRef = useRef(0);
  const suppressMouseResizeRef = useRef(false);
  const prefersReducedMotion = useReducedMotion();
  const trackpadFeedback = useMotionValue(0);
  // The edge bounce reuses the snap transition's doorway pose: the pushed
  // panel swings out behind its hinge edge instead of merely translating.
  const trackpadBounceX = useTransform(trackpadFeedback, (value) => value * TRACKPAD_BOUNCE_TRANSLATE_RATIO);
  const trackpadBounceRotateY = useTransform(trackpadFeedback, (value) =>
    Math.max(-TRACKPAD_BOUNCE_MAX_DEG, Math.min(TRACKPAD_BOUNCE_MAX_DEG, value * TRACKPAD_BOUNCE_DEG_PER_PX))
  );
  const trackpadBounceOrigin = useTransform(trackpadFeedback, (value) => (value >= 0 ? '0% 50%' : '100% 50%'));

  useEffect(() => {
    const storedWidth = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (!storedWidth) return;
    const nextWidth = Number.parseInt(storedWidth, 10);
    if (Number.isFinite(nextWidth)) setSidebarWidth(clampSidebarWidth(nextWidth));
  }, []);

  useEffect(() => {
    if (!overlay) return;
    window.clearTimeout(autoRevealCloseTimerRef.current);
    setAutoRevealClosing(false);
  }, [overlay]);

  const pagerSurfaces = useMemo<SidebarPagerSurface[]>(
    () => (showSettings ? [settingsReturnSurface, 'settings'] : ['workspace', 'studio']),
    [settingsReturnSurface, showSettings]
  );
  const activeSidebarSurface: SidebarPagerSurface = showSettings ? 'settings' : showStudio ? 'studio' : 'workspace';
  const activeSidebarPageIndex = Math.max(0, pagerSurfaces.indexOf(activeSidebarSurface));

  const openMenuAction = (action: () => void) => {
    setMenuOpen(false);
    action();
  };

  const onDaemonMenuOpenChange = useCallback(
    (open: boolean) => {
      setMenuOpen(open);
      if (open && autoCollapseOnPointerLeave) revealSidebar();
    },
    [autoCollapseOnPointerLeave, revealSidebar]
  );

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
      window.clearTimeout(trackpadResetTimerRef.current);
      pagerGestureRef.current.reset();
      trackpadFeedbackAnimationRef.current?.stop();
      trackpadFeedback.set(0);
      trackpadFeedbackSampleRef.current = { time: 0, x: 0 };
      trackpadFeedbackVelocityRef.current = 0;
      trackpadGestureActiveRef.current = false;
      dragActiveRef.current = false;
      dragPxRef.current = 0;
      setResizing(true);

      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.documentElement.dataset.sidebarResizing = 'true';

      const onResizeMove = (resizeEvent: MouseEvent | PointerEvent) => {
        setMeasuredSidebarWidth(dragStartRef.current.width + resizeEvent.clientX - dragStartRef.current.pointerX);
      };
      const onResizeEnd = () => {
        resizingRef.current = false;
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
    [setMeasuredSidebarWidth, sidebarWidth, trackpadFeedback]
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

  const stopTrackpadFeedbackAnimation = useCallback(() => {
    trackpadFeedbackAnimationRef.current?.stop();
    trackpadFeedbackAnimationRef.current = null;
  }, []);

  const clearTrackpadGesture = useCallback(() => {
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
    panelScrollAnimationRef.current = animate(host.scrollLeft, target, {
      duration: PANEL_SNAP_SCROLL_DURATION_S,
      ease: PANEL_SNAP_SCROLL_EASE,
      onComplete: finish,
      onUpdate: (value) => {
        host.scrollLeft = value;
      }
    });
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
    const wasShowingSettings = previousShowSettingsRef.current;
    const enteringSettings = showSettings && !wasShowingSettings;
    const leavingSettings = !showSettings && wasShowingSettings;
    previousShowSettingsRef.current = showSettings;
    if (enteringSettings) host.scrollTo({ behavior: 'instant' as ScrollBehavior, left: 0 });
    const target = activeSidebarPageIndex * host.clientWidth;
    if (leavingSettings) {
      window.clearTimeout(routeDrivenScrollClearTimerRef.current);
      panelScrollAnimationRef.current?.stop();
      host.scrollTo({ behavior: 'instant' as ScrollBehavior, left: target });
      host.dataset.snapReady = 'true';
      return;
    }
    if (Math.abs(host.scrollLeft - target) <= 1) {
      host.dataset.snapReady = 'true';
      window.clearTimeout(routeDrivenScrollClearTimerRef.current);
      return;
    }
    window.clearTimeout(routeDrivenScrollClearTimerRef.current);
    panelScrollAnimationRef.current?.stop();
    if (host.dataset.snapReady !== 'true' || prefersReducedMotion) {
      host.scrollTo({ behavior: 'instant' as ScrollBehavior, left: target });
    } else {
      // Browser smooth scrolling has a fixed, sluggish pace; drive scrollLeft
      // with a short ease-out tween so programmatic page turns feel crisp.
      panelScrollAnimationRef.current = animate(host.scrollLeft, target, {
        duration: PANEL_SNAP_SCROLL_DURATION_S,
        ease: PANEL_SNAP_SCROLL_EASE,
        onUpdate: (value) => {
          host.scrollLeft = value;
        }
      });
    }
    host.dataset.snapReady = 'true';
  }, [activeSidebarPageIndex, activeSidebarSurface, prefersReducedMotion, showSettings]);

  useEffect(
    () => () => {
      panelScrollAnimationRef.current?.stop();
      window.clearTimeout(routeDrivenScrollClearTimerRef.current);
      window.clearTimeout(autoRevealCloseTimerRef.current);
    },
    []
  );

  useEffect(() => {
    const host = panelScrollRef.current;
    if (!host) return;

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
      const width = host.clientWidth || 1;
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
        window.clearTimeout(pageTurnLockTimerRef.current);
        pageTurnLockTimerRef.current = window.setTimeout(clearTrackpadGesture, PAGE_TURN_LOCK_MS);
        currentSidebarSurfaceRef.current = targetSurfaceId;
        if (!closesSettings) {
          if (targetSurfaceId === 'settings') onToggleSettings();
          if (targetSurfaceId === 'studio') onOpenStudio();
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
          panelScrollAnimationRef.current = animate(host.scrollLeft, target, {
            duration: PANEL_SNAP_SCROLL_DURATION_S,
            ease: PANEL_SNAP_SCROLL_EASE,
            onComplete: finishSettingsClose,
            onUpdate: (value) => {
              host.scrollLeft = value;
            }
          });
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
      // The lock lifts on its own a short beat after the turn (armed in finishPageTurn), so
      // it never waits out the full multi-second momentum tail.
      if (pageTurnConsumedRef.current) return;
      const edgeMaxPx = host.clientWidth + TRACKPAD_EDGE_MARGIN_PX;
      const seedPx = !dragActiveRef.current ? sidebarTrackpadEdgeAccum(trackpadFeedback.get(), edgeMaxPx) : 0;
      const result = pagerGestureRef.current.update({
        deltaX: event.deltaX,
        now: event.timeStamp,
        seedPx
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

      const maxScroll = host.scrollWidth - host.clientWidth;
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
    clearTrackpadGesture,
    onCloseSettings,
    onOpenStudio,
    onOpenWorkspace,
    onToggleSettings,
    pagerSurfaces,
    prefersReducedMotion,
    releaseTrackpadGesture,
    showSettings,
    stopTrackpadFeedbackAnimation,
    trackpadFeedback
  ]);

  useEffect(() => clearTrackpadGesture, [clearTrackpadGesture]);

  const activeSidebarWidth = collapsed || overlay ? DEFAULT_SIDEBAR_WIDTH : sidebarWidth;
  const expandedStyle = { width: activeSidebarWidth } satisfies CSSProperties;
  const animateSidebar = overlay || autoRevealClosing;
  const daemonStatusText =
    daemonStatus === 'online'
      ? t('web.sidebar.daemonOnline')
      : daemonStatus === 'offline'
        ? t('web.sidebar.daemonOffline')
        : t('web.sidebar.daemonChecking');
  const daemonStatusClass =
    daemonStatus === 'online' ? 'bg-success' : daemonStatus === 'offline' ? 'bg-destructive' : 'bg-muted-foreground';

  return (
    <aside
      className={cn(
        'panel-nav group/sidebar hidden h-full min-h-0 flex-col overflow-hidden text-foreground md:flex',
        (collapsed || overlay) && 'panel-nav-overlay',
        resizing
          ? 'transition-none'
          : animateSidebar
            ? 'transition-[width,opacity,transform] duration-200 ease-out will-change-transform'
            : 'transition-none',
        overlay && !collapsed && 'translate-x-0 opacity-100',
        collapsed && 'pointer-events-none -translate-x-6 opacity-0'
      )}
      data-resizing={resizing}
      onPointerLeave={(event) => {
        if (!autoCollapseOnPointerLeave || menuOpen) return;
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Element && nextTarget.closest('[data-sidebar-chrome="true"]')) return;
        window.clearTimeout(autoRevealCloseTimerRef.current);
        setAutoRevealClosing(true);
        autoRevealCloseTimerRef.current = window.setTimeout(() => {
          autoRevealCloseTimerRef.current = 0;
          setAutoRevealClosing(false);
        }, AUTO_REVEAL_CLOSE_ANIMATION_MS);
        collapseSidebar();
      }}
      ref={sidebarRef}
      style={expandedStyle}
    >
      <div
        className="flex h-full min-h-0 flex-col"
        style={expandedStyle}
      >
        <SidebarHeader
          collapsed={collapsed}
          onOpenWorkspace={onOpenWorkspace}
          onToggleCollapsed={toggleSidebarCollapsed}
          t={t}
        />

        {!collapsed ? (
          <motion.div
            className="flex min-h-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            data-sidebar-trackpad-surface="true"
            ref={panelScrollRef}
            style={{
              overscrollBehaviorX: 'contain',
              rotateY: trackpadBounceRotateY,
              transformOrigin: trackpadBounceOrigin,
              transformPerspective: 1100,
              x: trackpadBounceX
            }}
          >
            {pagerSurfaces.map((surface) => (
              <div
                className="panel-nav-snap-item flex min-h-0 w-full flex-none flex-col"
                key={surface}
              >
                {surface === 'settings' ? (
                  <SettingsSidebarItems
                    activeSection={settingsSection}
                    onBack={closeSettingsWithPagerAnimation}
                    onSelect={onOpenSettingsSection}
                    t={t}
                  />
                ) : surface === 'studio' ? (
                  <StudioSidebarItems
                    activeSection={studioSection}
                    onSelect={onOpenStudioSection}
                    runtimeReady={runtimeReady}
                    shortcutModifierLabel={shortcutModifierLabel}
                    showShortcutBadges={showShortcutBadges}
                    t={t}
                  />
                ) : (
                  <WorkspaceSidebarItems
                    activeProjectId={activeProjectId}
                    activeSessionId={activeProjectSessionId}
                    monadChatActive={monadChatActive}
                    onOpenMonadChat={onOpenMonadChat}
                    onOpenProject={onOpenProject}
                    onOpenProjectSession={onOpenProjectSession}
                    onOpenProjectSettings={onOpenProjectSettings}
                    onToggleProjectPinned={toggleProjectPinned}
                    projects={projects}
                    shortcutModifierLabel={shortcutModifierLabel}
                    showShortcutBadges={showShortcutBadges}
                    t={t}
                  />
                )}
              </div>
            ))}
          </motion.div>
        ) : null}

        {!collapsed ? (
          <div className="relative flex items-center gap-1 px-2.5 py-2">
            <DaemonMenu
              daemonBaseUrl={daemonBaseUrl}
              daemonStatus={daemonStatus}
              daemonStatusClass={daemonStatusClass}
              daemonStatusText={daemonStatusText}
              daemonVersion={daemonStatus === 'online' ? daemonVersion : undefined}
              hasUpgrade={hasUpgrade}
              menuOpen={menuOpen}
              networkRuntime={networkRuntime}
              onOpenChange={onDaemonMenuOpenChange}
              onOpenStudio={() => openMenuAction(onOpenStudio)}
              onOpenWorkspace={() => openMenuAction(onOpenWorkspace)}
              onSwitchDaemonConnection={onSwitchDaemonConnection}
              onToggleSettings={() => openMenuAction(onToggleSettings)}
              shortcutModifierLabel={shortcutModifierLabel}
              showSettings={showSettings}
              studioPileActive={studioPileActive}
              t={t}
              workspacePileActive={workspacePileActive}
            />
            <ThemeToggle />
          </div>
        ) : null}
      </div>
      {!collapsed && !overlay ? (
        <hr
          aria-label={t('web.shell.resizeSidebar')}
          aria-orientation="vertical"
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuenow={sidebarWidth}
          className="panel-nav-resize-handle"
          data-preserve-cursor="true"
          onKeyDown={onResizeKeyDown}
          onMouseDown={onResizeMouseDown}
          onPointerDown={onResizePointerDown}
          tabIndex={0}
        />
      ) : null}
    </aside>
  );
}
