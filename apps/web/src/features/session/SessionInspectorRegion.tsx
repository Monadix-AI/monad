'use client';

import type { SessionIdentityModel, SessionInspectorModel } from './session-route-contract';

import { CpuIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

import { useT } from '#/components/I18nProvider';
import { RightPanelContent } from '#/features/shell/right-panel/RightPanelContent';
import { AgentLoopInspector } from './AgentLoopInspector';

export function SessionInspectorRegion({
  identity,
  inspector
}: {
  identity: SessionIdentityModel;
  inspector: SessionInspectorModel;
}) {
  const t = useT();
  if (!inspector.open) return null;

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
