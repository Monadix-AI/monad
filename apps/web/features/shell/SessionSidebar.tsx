'use client';

import type { StudioSectionId } from '@/features/studio/sections';
import type { RemoteDaemonConnection } from '@/lib/daemon-connections';

import { cn } from '@monad/ui';
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react';

import { useT } from '@/components/I18nProvider';
import { ThemeToggle } from '@/components/ThemeToggle';
import { DaemonMenu } from './SessionSidebarDaemonMenu';
import { type ProjectItem, SidebarHeader, StudioSidebarItems, WorkspaceSidebarItems } from './SessionSidebarNav';

interface Props {
  autoCollapseOnPointerLeave?: boolean;
  projects: ProjectItem[];
  collapsed: boolean;
  overlay?: boolean;
  hasUpgrade?: boolean;
  showSettings: boolean;
  showStudio: boolean;
  studioPileActive: boolean;
  workspacePileActive: boolean;
  monadChatActive: boolean;
  activeProjectId: string | null;
  daemonBaseUrl: string;
  daemonStatus: 'checking' | 'online' | 'offline';
  daemonVersion?: string;
  studioSection: StudioSectionId;
  shortcutModifierLabel?: string;
  showShortcutBadges?: boolean;
  onOpenWorkspace: () => void;
  onOpenMonadChat: () => void;
  onOpenProject: (id: string) => void;
  onOpenStudioSection: (section: StudioSectionId) => void;
  onRequestCollapse?: () => void;
  onRequestPersistentExpand?: () => void;
  onSwitchDaemonConnection: (
    request: { type: 'local' } | { connection: RemoteDaemonConnection; type: 'remote' }
  ) => void;
  onToggleCollapsed: () => void;
  onToggleSettings: () => void;
  onToggleStudio: () => void;
}

const DEFAULT_SIDEBAR_WIDTH = 288;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 420;
const SIDEBAR_WIDTH_STORAGE_KEY = 'monad:web:sidebar-width';

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

export function SessionSidebar({
  autoCollapseOnPointerLeave,
  projects,
  collapsed,
  overlay,
  hasUpgrade,
  showSettings,
  showStudio,
  studioPileActive,
  workspacePileActive,
  monadChatActive,
  activeProjectId,
  daemonBaseUrl,
  daemonStatus,
  daemonVersion,
  studioSection,
  shortcutModifierLabel = '⌘',
  showShortcutBadges,
  onOpenWorkspace,
  onOpenMonadChat,
  onOpenProject,
  onOpenStudioSection,
  onRequestCollapse,
  onRequestPersistentExpand,
  onSwitchDaemonConnection,
  onToggleCollapsed,
  onToggleSettings,
  onToggleStudio
}: Props) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
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

  const openMenuAction = (action: () => void) => {
    setMenuOpen(false);
    action();
  };

  const onDaemonMenuOpenChange = useCallback(
    (open: boolean) => {
      setMenuOpen(open);
      if (open && autoCollapseOnPointerLeave) onRequestPersistentExpand?.();
    },
    [autoCollapseOnPointerLeave, onRequestPersistentExpand]
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
      dragStartRef.current = { pointerX: clientX, width: sidebarWidth };
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
    [setMeasuredSidebarWidth, sidebarWidth]
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
      if (event.key === 'Home') setMeasuredSidebarWidth(MIN_SIDEBAR_WIDTH);
      else if (event.key === 'End') setMeasuredSidebarWidth(MAX_SIDEBAR_WIDTH);
      else setMeasuredSidebarWidth(sidebarWidth + (event.key === 'ArrowRight' ? 12 : -12));
    },
    [setMeasuredSidebarWidth, sidebarWidth]
  );

  const expandedStyle = { width: sidebarWidth } satisfies CSSProperties;
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
        'panel-nav group/sidebar hidden h-full min-h-0 flex-col overflow-hidden text-sidebar-foreground md:flex',
        (collapsed || overlay) && 'panel-nav-overlay',
        resizing ? 'transition-none' : 'transition-[width,opacity,transform] duration-200 ease-out',
        overlay && !collapsed && 'translate-x-0 opacity-100',
        collapsed && 'pointer-events-none -translate-x-[calc(100%-12px)] opacity-0'
      )}
      data-resizing={resizing}
      onPointerLeave={() => {
        if (autoCollapseOnPointerLeave && !menuOpen) onRequestCollapse?.();
      }}
      style={expandedStyle}
    >
      <div
        className="flex h-full min-h-0 flex-col"
        style={expandedStyle}
      >
        <SidebarHeader
          onOpenWorkspace={onOpenWorkspace}
          onToggleCollapsed={onToggleCollapsed}
          t={t}
        />

        <div
          className="panel-nav-mode flex min-h-0 flex-1 flex-col"
          data-mode={showStudio ? 'studio' : 'workspace'}
          key={showStudio ? 'studio' : 'workspace'}
        >
          {showStudio ? (
            <StudioSidebarItems
              activeSection={studioSection}
              onSelect={onOpenStudioSection}
              shortcutModifierLabel={shortcutModifierLabel}
              showShortcutBadges={showShortcutBadges}
              t={t}
            />
          ) : (
            <WorkspaceSidebarItems
              activeProjectId={activeProjectId}
              monadChatActive={monadChatActive}
              onOpenMonadChat={onOpenMonadChat}
              onOpenProject={onOpenProject}
              projects={projects}
              t={t}
            />
          )}
        </div>

        <div className="relative flex items-center gap-1 px-2.5 py-2">
          <DaemonMenu
            daemonBaseUrl={daemonBaseUrl}
            daemonStatus={daemonStatus}
            daemonStatusClass={daemonStatusClass}
            daemonStatusText={daemonStatusText}
            daemonVersion={daemonStatus === 'online' ? daemonVersion : undefined}
            hasUpgrade={hasUpgrade}
            menuOpen={menuOpen}
            onOpenChange={onDaemonMenuOpenChange}
            onOpenWorkspace={() => openMenuAction(onOpenWorkspace)}
            onSwitchDaemonConnection={onSwitchDaemonConnection}
            onToggleSettings={() => openMenuAction(onToggleSettings)}
            onToggleStudio={() => openMenuAction(onToggleStudio)}
            shortcutModifierLabel={shortcutModifierLabel}
            showSettings={showSettings}
            studioPileActive={studioPileActive}
            t={t}
            workspacePileActive={workspacePileActive}
          />
          <ThemeToggle />
        </div>
      </div>
      <hr
        aria-label="Resize sidebar"
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
    </aside>
  );
}
