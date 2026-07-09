'use client';

import { cn } from '@monad/ui';

import { useWorkspaceShellStore } from '#/lib/workspace-shell-store';
import { useRightPanel } from './right-panel-context';

const RIGHT_PANEL_WIDTH_CLASS = 'w-[min(440px,32vw)]';

// Shared right-hand column. It owns the frame (border, width, slide) and the
// scroll-capable body; routes fill the body through <RightPanelContent>. Kept as a
// pure layout shell so any surface can reuse it without knowing what it contains.
export function RightPanel() {
  const { setSlot, hasContent } = useRightPanel();
  const open = useWorkspaceShellStore((state) => state.rightPanelOpen);
  const visible = open && hasContent;

  return (
    <aside
      aria-hidden={!visible}
      className={cn(
        'relative hidden h-full min-h-0 shrink-0 flex-col overflow-hidden bg-background transition-[width] duration-200 ease-out lg:flex',
        visible ? cn(RIGHT_PANEL_WIDTH_CLASS, 'border-border/70 border-l') : 'w-0 border-l-0'
      )}
      data-open={visible}
      data-testid="right-panel"
    >
      <div
        className={cn('flex min-h-0 flex-1 flex-col', RIGHT_PANEL_WIDTH_CLASS)}
        ref={setSlot}
      />
    </aside>
  );
}
