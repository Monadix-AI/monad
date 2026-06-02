import { CheckmarkSquare02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

import { useT } from '#/components/I18nProvider';
import { RightPanelContent } from '#/features/shell/right-panel/RightPanelContent';
import { useWorkspaceShellStore } from '#/lib/workspace-shell-store';
import { SessionPlanPanel } from './SessionPlanPanel';
import { useSessionContext } from './session-context';

export function SessionPlanRegion() {
  const t = useT();
  const { identity } = useSessionContext();
  const planOpen = useWorkspaceShellStore((state) => state.rightPanelOpen && state.rightPanelView === 'plan');
  if (!planOpen) return null;

  return (
    <RightPanelContent
      icon={
        <HugeiconsIcon
          className="size-4 text-muted-foreground"
          icon={CheckmarkSquare02Icon}
        />
      }
      ownerId={`session:${identity.currentSessionId}`}
      subtitle={t('web.plan.subtitle')}
      title={t('web.plan.title')}
    >
      <SessionPlanPanel sessionId={identity.currentSessionId} />
    </RightPanelContent>
  );
}
