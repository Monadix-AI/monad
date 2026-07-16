import type { SessionInspectorModel } from './session-route-contract';

import { CpuIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

import { useT } from '#/components/I18nProvider';
import { RightPanelContent } from '#/features/shell/right-panel/RightPanelContent';
import { useWorkspaceShellStore } from '#/lib/workspace-shell-store';
import { AgentLoopInspector } from './AgentLoopInspector';
import { useSessionContext } from './session-context';

export function SessionInspectorRegion({ inspector }: { inspector: SessionInspectorModel }) {
  const t = useT();
  const { identity } = useSessionContext();
  const inspectorOpen = useWorkspaceShellStore((state) => state.rightPanelOpen);
  if (!inspectorOpen) return null;

  return (
    <RightPanelContent
      icon={
        <HugeiconsIcon
          className="size-4 text-muted-foreground"
          icon={CpuIcon}
        />
      }
      ownerId={`session:${identity.currentSessionId}`}
      subtitle={t('web.inspector.subtitle')}
      title={t('web.inspector.title')}
    >
      <AgentLoopInspector items={inspector.items} />
    </RightPanelContent>
  );
}
