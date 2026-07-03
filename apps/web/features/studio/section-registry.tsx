'use client';

import type { ComponentType } from 'react';
import type { StudioSectionId } from './sections';

import dynamic from 'next/dynamic';

import { AgentsPanel } from './AgentsPanel';
import { Orchestration } from './Orchestration';
import { SandboxDefaults } from './SandboxDefaults';
import { Usage } from './Usage';

export interface StudioSectionProps {
  onClose: () => void;
  subpath?: string[];
}

export type StudioSectionComponent = ComponentType<StudioSectionProps>;

const ModelSettings = dynamic(() => import('./model-settings').then((m) => m.ModelSettings), { ssr: false });
const ChannelsSettings = dynamic(() => import('./channels-settings').then((m) => m.ChannelsSettings), {
  ssr: false
});
const AtomsSettings = dynamic(() => import('./atoms-settings').then((m) => m.AtomsSettings), {
  ssr: false
});
const ThirdPartyAgentsSettings = dynamic(() => import('./third-party-agents').then((m) => m.ThirdPartyAgentsSettings), {
  ssr: false
});
const SkillsSettings = dynamic(() => import('./skills-settings').then((m) => m.SkillsSettings), {
  ssr: false
});
const CapabilitiesSettings = dynamic(() => import('./capabilities-settings').then((m) => m.CapabilitiesSettings), {
  ssr: false
});
const ApprovalsSettings = dynamic(() => import('./approvals-settings').then((m) => m.ApprovalsSettings), {
  ssr: false
});
const MemorySettings = dynamic(() => import('./memory-settings/MemorySettings').then((m) => m.MemorySettings), {
  ssr: false
});
const GraphMemorySettings = dynamic(
  () =>
    import('./memory-settings/MemorySettings').then((m) => {
      return function GraphMemorySettings(props: StudioSectionProps) {
        return (
          <m.MemorySettings
            {...props}
            initialTab="graph"
          />
        );
      };
    }),
  { ssr: false }
);
const Mem0MemorySettings = dynamic(
  () =>
    import('./memory-settings/MemorySettings').then((m) => {
      return function Mem0MemorySettings(props: StudioSectionProps) {
        return (
          <m.MemorySettings
            {...props}
            initialTab="mem0"
          />
        );
      };
    }),
  { ssr: false }
);
const HooksSettings = dynamic(() => import('./hooks-settings/HooksSettings').then((m) => m.HooksSettings), {
  ssr: false
});

function SandboxSection() {
  return <SandboxDefaults />;
}

function OrchestrationSection() {
  return <Orchestration />;
}

function UsageSection() {
  return <Usage />;
}

export const STUDIO_SECTION_COMPONENTS: Record<StudioSectionId, StudioSectionComponent> = {
  acpAgents: ThirdPartyAgentsSettings,
  agents: AgentsPanel,
  approvals: ApprovalsSettings,
  atoms: AtomsSettings,
  capabilities: CapabilitiesSettings,
  channels: ChannelsSettings,
  graph: GraphMemorySettings,
  hooks: HooksSettings,
  mcpAtoms: CapabilitiesSettings,
  mcpServers: CapabilitiesSettings,
  mem0: Mem0MemorySettings,
  memory: MemorySettings,
  models: ModelSettings,
  nativeCliAgents: ThirdPartyAgentsSettings,
  orchestration: OrchestrationSection,
  sandbox: SandboxSection,
  skills: SkillsSettings,
  thirdPartyAgents: ThirdPartyAgentsSettings,
  tools: CapabilitiesSettings,
  usage: UsageSection
};
