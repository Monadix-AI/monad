'use client';

import type { WheelEvent as ReactWheelEvent } from 'react';

import { PanelLeftCloseIcon, PanelLeftOpenIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button } from '@monad/ui';

import { MonadLogo } from '@/components/MonadLogo';
import { isSidebarHorizontalWheel } from './sidebar-trackpad-switch';

export function AppShellSidebarReveal({
  autoRevealSidebar,
  autoMode,
  onOpenWorkspace,
  onToggleAutoMode
}: {
  autoRevealSidebar: () => void;
  autoMode: boolean;
  onOpenWorkspace: () => void;
  onToggleAutoMode: () => void;
}) {
  const toggleLabel = autoMode ? 'Keep sidebar expanded' : 'Auto-hide sidebar';
  const preventHorizontalHistorySwipe = (event: ReactWheelEvent<HTMLElement>) => {
    if (!isSidebarHorizontalWheel(event)) return;
    event.preventDefault();
    if (autoMode) autoRevealSidebar();
  };

  return (
    <>
      {autoMode ? (
        <div
          aria-hidden="true"
          className="absolute inset-y-0 left-0 z-20 w-3"
          onPointerDown={autoRevealSidebar}
          onPointerEnter={autoRevealSidebar}
          onWheelCapture={preventHorizontalHistorySwipe}
        />
      ) : null}
      <div
        className="absolute top-0 left-0 z-40 flex h-[52px] items-center gap-2 px-3"
        data-sidebar-chrome="true"
        onWheelCapture={preventHorizontalHistorySwipe}
      >
        <button
          aria-label="Monad"
          className="poster-heading flex min-w-0 cursor-pointer items-center text-sidebar-primary transition hover:text-sidebar-foreground"
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
          <HugeiconsIcon icon={autoMode ? PanelLeftCloseIcon : PanelLeftOpenIcon} />
        </Button>
      </div>
    </>
  );
}
