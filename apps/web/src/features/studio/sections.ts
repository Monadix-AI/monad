import type { IconSvgElement } from '@hugeicons/react';
import type { WebMessageIdWithoutParams } from '@monad/i18n/browser';

import {
  BotIcon,
  BrainIcon,
  CpuIcon,
  FileInputIcon,
  GeometricShapesIcon,
  Home01Icon,
  Key01Icon,
  MessageMultiple01Icon,
  NeuralNetworkIcon,
  PackageIcon,
  ShieldHalfIcon,
  TerminalIcon,
  UserGroupIcon,
  WorkflowSquare01Icon
} from '@hugeicons/core-free-icons';

export type StudioSectionId =
  | 'runtime'
  | 'agents'
  | 'credentials'
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
  | 'meshAgents'
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
  | 'import'
  | 'sandbox'
  | 'safety';

const STUDIO_SECTION_IDS = [
  'runtime',
  'agents',
  'credentials',
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
  'meshAgents',
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
  'import',
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

export const DEFAULT_STUDIO_SECTION = 'mesh' as const satisfies StudioSectionId;

export const STUDIO_RUNTIME_SECTIONS: StudioSectionItem[] = [
  { id: 'runtime', icon: Home01Icon, i18nKey: 'web.studio.runtimeOverview' },
  { id: 'models', icon: CpuIcon, i18nKey: 'web.studio.modelsAndProviders' },
  { id: 'agents', icon: UserGroupIcon, i18nKey: 'web.studio.monadAgents' },
  { id: 'credentials', icon: Key01Icon, i18nKey: 'web.credentials.title' },
  { id: 'capabilities', icon: GeometricShapesIcon, i18nKey: 'web.studio.capabilities' },
  { id: 'acpDelegates', icon: BotIcon, i18nKey: 'web.studio.acpDelegates' },
  // Memory folds the former standalone graph + mem0 sections into tabs (deep links /studio/graph and
  // /studio/mem0 still resolve — they open the matching tab — so those ids stay in the union below).
  { id: 'memory', icon: BrainIcon, i18nKey: 'web.settings.memory' },
  { id: 'safety', icon: ShieldHalfIcon, i18nKey: 'web.studio.safety' },
  { id: 'hooks', icon: WorkflowSquare01Icon, i18nKey: 'web.studio.hooks' }
];

export const STUDIO_MESH_SECTIONS: StudioSectionItem[] = [
  { id: DEFAULT_STUDIO_SECTION, icon: NeuralNetworkIcon, i18nKey: 'web.studio.meshOverview' },
  { id: 'meshAgents', icon: TerminalIcon, i18nKey: 'web.studio.meshAgents' }
];

// System: host-level facilities that belong to neither the runtime nor the mesh.
export const STUDIO_SYSTEM_SECTIONS: StudioSectionItem[] = [
  { id: 'channels', icon: MessageMultiple01Icon, i18nKey: 'web.ch.title' },
  { id: 'import', icon: FileInputIcon, i18nKey: 'web.settings.import' },
  { id: 'atoms', icon: PackageIcon, i18nKey: 'web.studio.atoms' }
];

export const STUDIO_SIDEBAR_SECTIONS = [...STUDIO_MESH_SECTIONS, ...STUDIO_RUNTIME_SECTIONS, ...STUDIO_SYSTEM_SECTIONS];

const _STUDIO_AGENT_SECTIONS = STUDIO_RUNTIME_SECTIONS;
const _STUDIO_CAPABILITY_SECTIONS = STUDIO_MESH_SECTIONS;
