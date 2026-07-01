'use client';

import { ScrollArea } from '@monad/ui';

import { useT } from '@/components/I18nProvider';
import { PanelShell } from '@/components/ui/panel-shell';
import { StudioBreadcrumbHeader } from '@/features/studio/StudioBreadcrumbHeader';
import { McpSection } from './capabilities/McpSection';
import { ToolsSection } from './capabilities/ToolsSection';

// Capabilities: one panel composing the agent's runtime capabilities into two sections — built-in
// Tools (toggle-only) and MCP servers (extendable, built-in + atom-pack). Replaces the former
// standalone Tools / MCP servers / MCP atoms panels.
export function CapabilitiesSettings(_props: { onClose: () => void }) {
  const t = useT();
  return (
    <PanelShell>
      <StudioBreadcrumbHeader title={t('web.studio.capabilities')} />
      <ScrollArea className="min-h-0 flex-1">
        <ToolsSection />
        <McpSection />
      </ScrollArea>
    </PanelShell>
  );
}
