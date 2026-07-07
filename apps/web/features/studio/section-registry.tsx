'use client';

import type { ComponentType } from 'react';
import type { StudioSectionId } from './sections';

import dynamic from 'next/dynamic';

import { PanelLoading } from '@/components/PanelLoading';
import { AgentsPanel } from './AgentsPanel';
import { MeshOverview, MeshPlaceholder } from './MeshOverview';
import { Orchestration } from './Orchestration';
import { RuntimeOverview } from './RuntimeOverview';
import { SafetyAndHooks } from './SafetyAndHooks';
import { SandboxDefaults } from './SandboxDefaults';
import { Usage } from './Usage';

export interface StudioSectionProps {
  onClose: () => void;
  subpath?: string[];
}

export type StudioSectionComponent = ComponentType<StudioSectionProps>;

const ModelSettings = dynamic(() => import('./model-settings').then((m) => m.ModelSettings), {
  loading: PanelLoading,
  ssr: false
});
const ChannelsSettings = dynamic(() => import('./channels-settings').then((m) => m.ChannelsSettings), {
  loading: PanelLoading,
  ssr: false
});
const AtomsSettings = dynamic(() => import('./atoms-settings').then((m) => m.AtomsSettings), {
  loading: PanelLoading,
  ssr: false
});
const ThirdPartyAgentsSettings = dynamic(() => import('./third-party-agents').then((m) => m.ThirdPartyAgentsSettings), {
  loading: PanelLoading,
  ssr: false
});
const SkillsSettings = dynamic(() => import('./skills-settings').then((m) => m.SkillsSettings), {
  loading: PanelLoading,
  ssr: false
});
const CapabilitiesSettings = dynamic(() => import('./capabilities-settings').then((m) => m.CapabilitiesSettings), {
  loading: PanelLoading,
  ssr: false
});
const ApprovalsSettings = dynamic(() => import('./approvals-settings').then((m) => m.ApprovalsSettings), {
  loading: PanelLoading,
  ssr: false
});
const MemorySettings = dynamic(() => import('./memory-settings/MemorySettings').then((m) => m.MemorySettings), {
  loading: PanelLoading,
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
  { loading: PanelLoading, ssr: false }
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
  { loading: PanelLoading, ssr: false }
);
const HooksSettings = dynamic(() => import('./hooks-settings/HooksSettings').then((m) => m.HooksSettings), {
  loading: PanelLoading,
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
  acpDelegates: ThirdPartyAgentsSettings,
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
  externalAgents: ExternalAgentsSection,
  orchestration: OrchestrationSection,
  projectMembers: ProjectMembersSection,
  runtime: RuntimeOverview,
  sandbox: SandboxSection,
  safety: SafetyAndHooks,
  skills: SkillsSettings,
  mesh: MeshOverview,
  meshTasks: MeshTasksSection,
  thirdPartyAgents: ThirdPartyAgentsSettings,
  tools: CapabilitiesSettings,
  usage: UsageSection,
  workplaceProjects: WorkplaceProjectsSection
};

function ExternalAgentsSection(props: StudioSectionProps) {
  return <ThirdPartyExternalAgents {...props} />;
}

const ThirdPartyExternalAgents = dynamic(
  () =>
    import('./third-party-agents/ExternalAgentsSettings').then((m) => {
      return function ExternalAgentsPage(props: StudioSectionProps) {
        return (
          <m.ExternalAgentsSettings
            {...props}
            embedded={false}
          />
        );
      };
    }),
  { loading: PanelLoading, ssr: false }
);

function WorkplaceProjectsSection() {
  return <MeshPlaceholder kind="projects" />;
}

function ProjectMembersSection() {
  return <MeshPlaceholder kind="members" />;
}

function MeshTasksSection() {
  return <MeshPlaceholder kind="tasks" />;
}
