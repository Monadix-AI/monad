'use client';

import { ScrollArea } from '@monad/ui';

import { useT } from '@/components/I18nProvider';
import { McpSection } from './capabilities/McpSection';
import { ToolsSection } from './capabilities/ToolsSection';
import { StudioPanel, StudioPanelHeader } from './studio/StudioPanel';

// Capabilities: one panel composing the agent's runtime capabilities into two sections — built-in
// Tools (toggle-only) and MCP servers (extendable, built-in + atom-pack). Replaces the former
// standalone Tools / MCP servers / MCP atoms panels.
export function CapabilitiesSettings(_props: { onClose: () => void }) {
  const t = useT();
  return (
    <StudioPanel>
      <StudioPanelHeader
        subtitle={t('web.studio.capabilitiesGroup')}
        title={t('web.studio.capabilities')}
      />
      <ScrollArea className="flex-1">
        <ToolsSection />
        <McpSection />
      </ScrollArea>
    </StudioPanel>
  );
}
