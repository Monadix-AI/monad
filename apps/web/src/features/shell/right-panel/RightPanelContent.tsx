'use client';

import type { ReactNode } from 'react';

import { Cancel01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, cn } from '@monad/ui';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';

import { useT } from '#/components/I18nProvider';
import { PanelShell, PanelShellBody, PanelShellHeader } from '#/components/ui/panel-shell';
import { useWorkspaceShellStore } from '#/lib/workspace-shell-store';
import { useRightPanel } from './right-panel-context';

type RightPanelContentProps = {
  title: ReactNode;
  icon?: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  // Text/list content scrolls the whole body; flex-fill content (e.g. a graph that
  // measures its own height) opts out and manages its own internal scrolling.
  scroll?: boolean;
};

// Renders route-owned content into the shared right-panel column, reusing the same
// PanelShellHeader chrome as every other panel and wiring the close affordance to the
// shell store. Registers itself so the column only claims width while mounted.
export function RightPanelContent({
  title,
  icon,
  subtitle,
  badge,
  actions,
  children,
  scroll = true
}: RightPanelContentProps) {
  const t = useT();
  const { slot, registerContent } = useRightPanel();
  const closeRightPanel = useWorkspaceShellStore((state) => state.closeRightPanel);

  useEffect(() => registerContent(), [registerContent]);

  if (!slot) return null;

  return createPortal(
    <PanelShell>
      <PanelShellHeader
        actions={
          <>
            {actions}
            <Button
              aria-label={t('web.rightPanel.close')}
              className="size-7 shrink-0"
              onClick={closeRightPanel}
              size="icon"
              variant="ghost"
            >
              <HugeiconsIcon
                className="size-4"
                icon={Cancel01Icon}
              />
            </Button>
          </>
        }
        badge={badge}
        icon={icon}
        insetForCollapsedSidebar={false}
        subtitle={subtitle}
        title={title}
      />
      <PanelShellBody className={cn(scroll ? 'scwf-scroll overflow-y-auto' : 'overflow-hidden')}>
        {children}
      </PanelShellBody>
    </PanelShell>,
    slot
  );
}
