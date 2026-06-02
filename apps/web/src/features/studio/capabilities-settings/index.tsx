import { useT } from '#/components/I18nProvider';
import { PanelShell, PanelShellBody } from '#/components/ui/panel-shell';
import { StudioBreadcrumbHeader } from '#/features/studio/StudioBreadcrumbHeader';
import { SkillsCapabilitiesSection } from '../skills-settings';
import { McpSection } from './McpSection';
import { ToolsSection } from './ToolsSection';

// Capabilities: one panel composing the agent's runtime capabilities into two sections — built-in
// Tools (toggle-only) and MCP servers (extendable, built-in + atom-pack). Replaces the former
// standalone Tools / MCP servers / MCP atoms panels.
export function CapabilitiesSettings(_props: { onClose: () => void }) {
  const t = useT();
  return (
    <PanelShell>
      <StudioBreadcrumbHeader title={t('web.studio.capabilities')} />
      <PanelShellBody
        className="overflow-y-auto"
        data-slot="capabilities-settings-panel"
      >
        <SkillsCapabilitiesSection />
        <ToolsSection />
        <McpSection />
      </PanelShellBody>
    </PanelShell>
  );
}
