'use client';

import type { useT } from '@/components/I18nProvider';

import { PanelLeftOpenIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button } from '@monad/ui';

type TFunction = ReturnType<typeof useT>;

export function AppShellSidebarReveal({
  autoRevealSidebar,
  revealSidebar,
  t
}: {
  autoRevealSidebar: () => void;
  revealSidebar: () => void;
  t: TFunction;
}) {
  return (
    <>
      <div
        aria-hidden="true"
        className="absolute inset-y-0 left-0 z-20 w-3"
        onPointerDown={autoRevealSidebar}
        onPointerEnter={autoRevealSidebar}
      />
      <Button
        aria-label={t('web.sidebar.expand')}
        className="glass-control absolute top-3 left-3 z-20 size-8"
        onClick={revealSidebar}
        size="icon"
        variant="secondary"
      >
        <HugeiconsIcon icon={PanelLeftOpenIcon} />
      </Button>
    </>
  );
}
