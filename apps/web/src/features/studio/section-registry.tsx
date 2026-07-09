'use client';

import type { ComponentType } from 'react';
import type { StudioSectionId } from './sections';

import { lazyComponent } from '#/lib/lazy-component';
import { AgentsPanel } from './AgentsPanel';
import { MeshOverview, MeshPlaceholder } from './MeshOverview';
import { Orchestration } from './Orchestration';
import { RuntimeOverview } from './RuntimeOverview';
import { SafetyAndHooks } from './SafetyAndHooks';
import { SandboxDefaults } from './SandboxDefaults';
import {
  AcpAgentsStudioLoading,
  ApprovalsStudioLoading,
  AtomsStudioLoading,
  CapabilitiesStudioLoading,
  ChannelsStudioLoading,
  ExternalAgentsStudioLoading,
  HooksStudioLoading,
  MemoryGraphStudioLoading,
  MemoryMem0StudioLoading,
  MemorySettingsStudioLoading,
  ModelsStudioLoading,
  SkillsStudioLoading
} from './StudioLoading';

export interface StudioSectionProps {
  onClose: () => void;
  subpath?: string[];
}

export type StudioSectionComponent = ComponentType<StudioSectionProps>;

const ModelSettings = lazyComponent(() => import('./model-settings').then((m) => m.ModelSettings), ModelsStudioLoading);
const ChannelsSettings = lazyComponent(
  () => import('./channels-settings').then((m) => m.ChannelsSettings),
  ChannelsStudioLoading
);
const AtomsSettings = lazyComponent(() => import('./atoms-settings').then((m) => m.AtomsSettings), AtomsStudioLoading);
const ThirdPartyAgentsSettings = lazyComponent(
  () => import('./third-party-agents').then((m) => m.ThirdPartyAgentsSettings),
  AcpAgentsStudioLoading
);
const SkillsSettings = lazyComponent(
  () => import('./skills-settings').then((m) => m.SkillsSettings),
  SkillsStudioLoading
);
const CapabilitiesSettings = lazyComponent(
  () => import('./capabilities-settings').then((m) => m.CapabilitiesSettings),
  CapabilitiesStudioLoading
);
const ApprovalsSettings = lazyComponent(
  () => import('./approvals-settings').then((m) => m.ApprovalsSettings),
  ApprovalsStudioLoading
);
const MemorySettings = lazyComponent(
  () => import('./memory-settings/MemorySettings').then((m) => m.MemorySettings),
  MemorySettingsStudioLoading
);
const GraphMemorySettings = lazyComponent(
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
  MemoryGraphStudioLoading
);
const Mem0MemorySettings = lazyComponent(
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
  MemoryMem0StudioLoading
);
const HooksSettings = lazyComponent(
  () => import('./hooks-settings/HooksSettings').then((m) => m.HooksSettings),
  HooksStudioLoading
);

function SandboxSection() {
  return <SandboxDefaults />;
}

function OrchestrationSection() {
  return <Orchestration />;
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
  workplaceProjects: WorkplaceProjectsSection
};

function ExternalAgentsSection(props: StudioSectionProps) {
  return <ThirdPartyExternalAgents {...props} />;
}

const ThirdPartyExternalAgents = lazyComponent(
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
  ExternalAgentsStudioLoading
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
