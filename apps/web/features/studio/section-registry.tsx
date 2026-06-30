'use client';

import type { ComponentType } from 'react';
import type { StudioSectionId } from './sections';

import dynamic from 'next/dynamic';

import { AgentsPanel } from './AgentsPanel';
import { Orchestration } from './Orchestration';
import { SandboxDefaults } from './SandboxDefaults';
import { Usage } from './Usage';

export type StudioSectionComponent = ComponentType<{ onClose: () => void }>;

const ModelSettings = dynamic(() => import('./model-settings').then((m) => m.ModelSettings), { ssr: false });
const ChannelsSettings = dynamic(() => import('@/features/settings/ChannelsSettings').then((m) => m.ChannelsSettings), {
  ssr: false
});
const AtomsSettings = dynamic(() => import('@/features/settings/AtomsSettings').then((m) => m.AtomsSettings), {
  ssr: false
});
const AcpAgentsSettings = dynamic(
  () => import('@/features/settings/AcpAgentsSettings').then((m) => m.AcpAgentsSettings),
  {
    ssr: false
  }
);
const NativeCliAgentsSettings = dynamic(
  () => import('@/features/settings/NativeCliAgentsSettings').then((m) => m.NativeCliAgentsSettings),
  { ssr: false }
);
const SkillsSettings = dynamic(() => import('./skills-settings').then((m) => m.SkillsSettings), {
  ssr: false
});
const CapabilitiesSettings = dynamic(
  () => import('@/features/settings/CapabilitiesSettings').then((m) => m.CapabilitiesSettings),
  {
    ssr: false
  }
);
const OpenaiCompatSettings = dynamic(
  () => import('@/features/settings/OpenaiCompatSettings').then((m) => m.OpenaiCompatSettings),
  {
    ssr: false
  }
);
const ApprovalsSettings = dynamic(
  () => import('@/features/settings/ApprovalsSettings').then((m) => m.ApprovalsSettings),
  {
    ssr: false
  }
);
const MemorySettings = dynamic(
  () => import('@/features/settings/memory/MemorySettings').then((m) => m.MemorySettings),
  {
    ssr: false
  }
);
const GraphMemorySettings = dynamic(
  () =>
    import('@/features/settings/memory/MemorySettings').then((m) => {
      return function GraphMemorySettings(props: { onClose: () => void }) {
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
    import('@/features/settings/memory/MemorySettings').then((m) => {
      return function Mem0MemorySettings(props: { onClose: () => void }) {
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
const HooksSettings = dynamic(() => import('@/features/settings/hooks/HooksSettings').then((m) => m.HooksSettings), {
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
  acpAgents: AcpAgentsSettings,
  agents: AgentsPanel,
  api: OpenaiCompatSettings,
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
  nativeCliAgents: NativeCliAgentsSettings,
  orchestration: OrchestrationSection,
  sandbox: SandboxSection,
  skills: SkillsSettings,
  tools: CapabilitiesSettings,
  usage: UsageSection
};
