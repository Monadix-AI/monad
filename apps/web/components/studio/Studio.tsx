'use client';

import type { StudioSectionId } from './sections';

import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';

import { studioSectionFromPathname } from '@/components/routes/route-paths';
import { AgentsPanel } from './AgentsPanel';
import { Orchestration } from './Orchestration';
import { SandboxDefaults } from './SandboxDefaults';
import { Usage } from './Usage';

const ModelSettings = dynamic(() => import('./ModelSettings').then((m) => m.ModelSettings), { ssr: false });
const ChannelsSettings = dynamic(() => import('../ChannelsSettings').then((m) => m.ChannelsSettings), { ssr: false });
const AtomsSettings = dynamic(() => import('../AtomsSettings').then((m) => m.AtomsSettings), { ssr: false });
const AcpAgentsSettings = dynamic(() => import('../AcpAgentsSettings').then((m) => m.AcpAgentsSettings), {
  ssr: false
});
const NativeCliAgentsSettings = dynamic(
  () => import('../NativeCliAgentsSettings').then((m) => m.NativeCliAgentsSettings),
  {
    ssr: false
  }
);
const SkillsSettings = dynamic(() => import('../SkillsSettings').then((m) => m.SkillsSettings), { ssr: false });
const CapabilitiesSettings = dynamic(() => import('../CapabilitiesSettings').then((m) => m.CapabilitiesSettings), {
  ssr: false
});
const OpenaiCompatSettings = dynamic(() => import('../OpenaiCompatSettings').then((m) => m.OpenaiCompatSettings), {
  ssr: false
});
const ApprovalsSettings = dynamic(() => import('../ApprovalsSettings').then((m) => m.ApprovalsSettings), {
  ssr: false
});
const MemorySettings = dynamic(() => import('../memory/MemorySettings').then((m) => m.MemorySettings), { ssr: false });
const HooksSettings = dynamic(() => import('../HooksSettings').then((m) => m.HooksSettings), { ssr: false });

/**
 * Studio: the two-layer model/agent workbench. Capabilities (system-level atomic config, reusing
 * the existing settings panels) + Agents (compose those capabilities into a named persona).
 */
export function Studio({ onClose }: { onClose: () => void }) {
  const pathname = usePathname();
  const section: StudioSectionId = studioSectionFromPathname(pathname) ?? 'agents';

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      {section === 'agents' ? (
        <AgentsPanel onClose={onClose} />
      ) : section === 'orchestration' ? (
        <Orchestration />
      ) : section === 'models' ? (
        <ModelSettings onClose={onClose} />
      ) : section === 'atoms' ? (
        <AtomsSettings onClose={onClose} />
      ) : section === 'skills' ? (
        <SkillsSettings onClose={onClose} />
      ) : section === 'capabilities' || section === 'tools' || section === 'mcpServers' || section === 'mcpAtoms' ? (
        <CapabilitiesSettings onClose={onClose} />
      ) : section === 'channels' ? (
        <ChannelsSettings onClose={onClose} />
      ) : section === 'nativeCliAgents' ? (
        <NativeCliAgentsSettings onClose={onClose} />
      ) : section === 'api' ? (
        <OpenaiCompatSettings onClose={onClose} />
      ) : section === 'approvals' ? (
        <ApprovalsSettings onClose={onClose} />
      ) : section === 'memory' ? (
        <MemorySettings onClose={onClose} />
      ) : section === 'graph' ? (
        <MemorySettings
          initialTab="graph"
          onClose={onClose}
        />
      ) : section === 'mem0' ? (
        <MemorySettings
          initialTab="mem0"
          onClose={onClose}
        />
      ) : section === 'hooks' ? (
        <HooksSettings onClose={onClose} />
      ) : section === 'sandbox' ? (
        <SandboxDefaults />
      ) : section === 'usage' ? (
        <Usage />
      ) : (
        <AcpAgentsSettings onClose={onClose} />
      )}
    </div>
  );
}
