import type { IconSvgElement } from '@hugeicons/react';
import type { WebMessageIdWithoutParams } from '@monad/i18n';

import {
  BotIcon,
  BrainIcon,
  CpuIcon,
  GeometricShapesIcon,
  Home01Icon,
  MessageSquareCodeIcon,
  NeuralNetworkIcon,
  PackageIcon,
  ShieldHalfIcon,
  TerminalIcon,
  UserGroupIcon
} from '@hugeicons/core-free-icons';

export type StudioSectionId =
  | 'runtime'
  | 'agents'
  | 'orchestration'
  | 'models'
  | 'atoms'
  | 'skills'
  | 'mcpServers'
  | 'channels'
  | 'thirdPartyAgents'
  | 'acpDelegates'
  | 'acpAgents'
  | 'mesh'
  | 'externalAgents'
  | 'workplaceProjects'
  | 'projectMembers'
  | 'meshTasks'
  | 'capabilities'
  | 'tools'
  | 'approvals'
  | 'memory'
  | 'graph'
  | 'mem0'
  | 'hooks'
  | 'mcpAtoms'
  | 'sandbox'
  | 'safety';

export const STUDIO_SECTION_IDS = [
  'runtime',
  'agents',
  'orchestration',
  'models',
  'atoms',
  'skills',
  'mcpServers',
  'channels',
  'thirdPartyAgents',
  'acpDelegates',
  'acpAgents',
  'mesh',
  'externalAgents',
  'workplaceProjects',
  'projectMembers',
  'meshTasks',
  'capabilities',
  'tools',
  'approvals',
  'memory',
  'graph',
  'mem0',
  'hooks',
  'mcpAtoms',
  'sandbox',
  'safety'
] as const satisfies readonly StudioSectionId[];

export function isStudioSectionId(value: string | null | undefined): value is StudioSectionId {
  return typeof value === 'string' && (STUDIO_SECTION_IDS as readonly string[]).includes(value);
}

export interface StudioSectionItem {
  id: StudioSectionId;
  icon: IconSvgElement;
  i18nKey: WebMessageIdWithoutParams;
}

export const STUDIO_RUNTIME_SECTIONS: StudioSectionItem[] = [
  { id: 'runtime', icon: Home01Icon, i18nKey: 'web.studio.runtimeOverview' },
  { id: 'models', icon: CpuIcon, i18nKey: 'web.studio.modelsAndProviders' },
  { id: 'agents', icon: UserGroupIcon, i18nKey: 'web.studio.monadAgents' },
  { id: 'capabilities', icon: GeometricShapesIcon, i18nKey: 'web.studio.capabilities' },
  { id: 'acpDelegates', icon: BotIcon, i18nKey: 'web.studio.acpDelegates' },
  // Memory folds the former standalone graph + mem0 sections into tabs (deep links /studio/graph and
  // /studio/mem0 still resolve — they open the matching tab — so those ids stay in the union below).
  { id: 'memory', icon: BrainIcon, i18nKey: 'web.settings.memory' },
  { id: 'safety', icon: ShieldHalfIcon, i18nKey: 'web.studio.safetyAndHooks' }
];

export const STUDIO_MESH_SECTIONS: StudioSectionItem[] = [
  { id: 'mesh', icon: NeuralNetworkIcon, i18nKey: 'web.studio.meshOverview' },
  { id: 'externalAgents', icon: TerminalIcon, i18nKey: 'web.studio.externalAgents' },
  { id: 'workplaceProjects', icon: MessageSquareCodeIcon, i18nKey: 'web.studio.workplaceProjects' }
];

// System: host-level facilities that belong to neither the runtime nor the mesh.
export const STUDIO_SYSTEM_SECTIONS: StudioSectionItem[] = [
  { id: 'atoms', icon: PackageIcon, i18nKey: 'web.studio.atoms' }
];

const _STUDIO_AGENT_SECTIONS = STUDIO_RUNTIME_SECTIONS;
const _STUDIO_CAPABILITY_SECTIONS = STUDIO_MESH_SECTIONS;
