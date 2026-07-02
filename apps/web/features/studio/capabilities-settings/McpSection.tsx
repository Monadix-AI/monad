'use client';

import { useT } from '@/components/I18nProvider';
import { CapabilitySection } from './CapabilitySection';
import { McpAtomsSubsection } from './McpAtomsSubsection';
import { McpPresetSubsection } from './McpPresetSubsection';
import { McpServersSubsection } from './McpServersSubsection';

// The MCP half of the Capabilities panel. One section, two source-labelled groups: config.json
// "built-in" servers and hot "atom-pack" servers. Each card carries its source badge.
export function McpSection() {
  const t = useT();
  return (
    <CapabilitySection
      subtitle={t('web.studio.capabilitiesMcpSubtitle')}
      title={t('web.studio.capabilitiesMcpSection')}
    >
      <div className="flex flex-col gap-6">
        <McpPresetSubsection />
        <McpServersSubsection />
        <McpAtomsSubsection />
      </div>
    </CapabilitySection>
  );
}
