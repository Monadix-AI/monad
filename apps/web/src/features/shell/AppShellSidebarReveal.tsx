import type { WheelEvent as ReactWheelEvent } from 'react';

import { PanelLeftCloseIcon, PanelLeftOpenIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button } from '@monad/ui';

import { useT } from '#/components/I18nProvider';
import { MonadLogo } from '#/components/MonadLogo';
import { useWorkspaceShellStore } from '#/lib/workspace-shell-store';
import { isSidebarHorizontalWheel } from './sidebar-trackpad-switch';

interface AppShellSidebarRevealProps {
  narrow: boolean;
  narrowOpen: boolean;
  onNarrowOpenChange: (open: boolean) => void;
  onOpenWorkspace: () => void;
}

export function AppShellSidebarReveal({
  narrow,
  narrowOpen,
  onNarrowOpenChange,
  onOpenWorkspace
}: AppShellSidebarRevealProps) {
  const t = useT();
  const sidebarCollapsed = useWorkspaceShellStore((state) => state.sidebarCollapsed);
  const sidebarAutoReveal = useWorkspaceShellStore((state) => state.sidebarAutoReveal);
  const autoRevealSidebar = useWorkspaceShellStore((state) => state.autoRevealSidebar);
  const collapseSidebar = useWorkspaceShellStore((state) => state.collapseSidebar);
  const revealSidebar = useWorkspaceShellStore((state) => state.revealSidebar);
  const autoMode = sidebarCollapsed || sidebarAutoReveal;
  const toggleLabel = narrow
    ? t(narrowOpen ? 'web.sidebar.collapse' : 'web.sidebar.expand')
    : autoMode
      ? 'Keep sidebar expanded'
      : 'Auto-hide sidebar';
  const onToggleAutoMode = narrow ? () => onNarrowOpenChange(!narrowOpen) : autoMode ? revealSidebar : collapseSidebar;
  const preventHorizontalHistorySwipe = (event: ReactWheelEvent<HTMLElement>) => {
    if (!isSidebarHorizontalWheel(event)) return;
    event.preventDefault();
    if (!narrow && autoMode) autoRevealSidebar();
  };

  return (
    <>
      {!narrow && autoMode ? (
        <div
          aria-hidden="true"
          className="absolute inset-y-0 left-0 z-20 w-3"
          onPointerDown={autoRevealSidebar}
          onPointerEnter={autoRevealSidebar}
          onWheelCapture={preventHorizontalHistorySwipe}
        />
      ) : null}
      <div
        className="sidebar-no-hover-transition absolute top-0 left-0 z-40 flex h-[52px] items-center gap-2 px-3"
        data-sidebar-chrome="true"
        onWheelCapture={preventHorizontalHistorySwipe}
      >
        <button
          aria-label="Monad"
          className="poster-heading flex min-w-0 items-center text-foreground transition hover:text-foreground"
          onClick={onOpenWorkspace}
          type="button"
        >
          <MonadLogo className="h-6 w-[4.75rem]" />
        </button>
        <Button
          aria-label={toggleLabel}
          className="size-7 shrink-0"
          onClick={onToggleAutoMode}
          size="icon"
          variant="ghost"
        >
          <HugeiconsIcon
            icon={
              narrow
                ? narrowOpen
                  ? PanelLeftCloseIcon
                  : PanelLeftOpenIcon
                : autoMode
                  ? PanelLeftCloseIcon
                  : PanelLeftOpenIcon
            }
          />
        </Button>
      </div>
    </>
  );
}
