import type { ToolsPanelProps } from './types';

import { PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useInstallAgentMcpMutation } from '@monad/client-rtk';
import { Button } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { McpServerDialog } from '#/features/studio/capabilities-settings/mcp-servers/McpServerDialog';
import { isResolvedEmptyList } from '#/lib/async-list-state';
import { CapabilityCard } from './CapabilityCard';
import { ToggleRow } from './PanelFields';

export function toggleDisabledSkill(current: string[], id: string): string[] {
  return current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
}

export function ToolsPanel(props: ToolsPanelProps) {
  const t = useT();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [installAgentMcp] = useInstallAgentMcpMutation();

  const setCapability = (id: string, checked: boolean) => {
    props.setAtomsAllow((current) =>
      checked ? [...new Set([...current, id])] : current.filter((candidate) => candidate !== id)
    );
  };

  return (
    <div className="space-y-4">
      <ToggleRow
        checked={props.atomsMode === 'inherit'}
        hint={t('web.studio.agentEditor.tools.workspaceSettingsHint')}
        label={t('web.studio.agentEditor.useWorkspaceSettings')}
        onCheckedChange={(checked) => props.setAtomsMode(checked ? 'inherit' : 'allowlist')}
      />
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-xs">{t('web.studio.agentEditor.tools.flatListHint')}</p>
        <Button
          onClick={() => setDialogOpen(true)}
          size="sm"
          variant="outline"
        >
          <HugeiconsIcon icon={PlusSignIcon} />
          {t('web.studio.agentEditor.tools.addMcp')}
        </Button>
      </div>
      {isResolvedEmptyList({
        isLoading: props.capabilityCatalogLoading,
        itemCount: props.capabilityCatalog.length
      }) ? (
        <p className="rounded-xl border border-dashed p-4 text-muted-foreground text-xs">
          {t('web.studio.agentEditor.tools.empty')}
        </p>
      ) : null}
      <div className="space-y-2">
        {props.capabilityCatalog.map((item) => (
          <CapabilityCard
            available={item.available}
            checked={props.atomsMode === 'inherit' || props.atomsAllow.includes(item.id)}
            detail={item.detail}
            key={item.id}
            labels={
              item.sourceKind === 'tool'
                ? [t('web.studio.agentEditor.badge.tool')]
                : item.sourceKind === 'atom'
                  ? [t('web.studio.agentEditor.badge.atomPack')]
                  : [
                      t('web.studio.agentEditor.badge.mcp'),
                      ...(item.sourceKind === 'agent-mcp' ? [t('web.studio.agentEditor.badge.agent')] : [])
                    ]
            }
            name={item.name}
            onCheckedChange={(checked) => setCapability(item.id, checked)}
            showSwitch={props.atomsMode === 'allowlist'}
          />
        ))}
      </div>
      <McpServerDialog
        onOpenChange={setDialogOpen}
        onSubmit={async (server) => {
          await installAgentMcp({ agentId: props.agentId, server, consent: true }).unwrap();
          if (props.atomsMode === 'allowlist') {
            setCapability(`agent:${props.agentDir}:mcp:${server.name}`, true);
          }
          props.onRefresh();
        }}
        open={dialogOpen}
      />
    </div>
  );
}
