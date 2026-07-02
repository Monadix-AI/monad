import type { IconSvgElement } from '@hugeicons/react';
import type { WebMessageIdWithoutParams } from '@monad/i18n';

import {
  Activity01Icon,
  BotIcon,
  BrainIcon,
  CpuIcon,
  GeometricShapesIcon,
  MessageSquareCodeIcon,
  NeuralNetworkIcon,
  PackageIcon,
  PuzzleIcon,
  ShieldHalfIcon,
  UserGroupIcon,
  WorkflowSquare01Icon
} from '@hugeicons/core-free-icons';

export type StudioSectionId =
  | 'agents'
  | 'orchestration'
  | 'models'
  | 'atoms'
  | 'skills'
  | 'mcpServers'
  | 'channels'
  | 'thirdPartyAgents'
  | 'acpAgents'
  | 'nativeCliAgents'
  | 'capabilities'
  | 'tools'
  | 'approvals'
  | 'memory'
  | 'graph'
  | 'mem0'
  | 'hooks'
  | 'mcpAtoms'
  | 'sandbox'
  | 'usage';

export const STUDIO_SECTION_IDS = [
  'agents',
  'orchestration',
  'models',
  'atoms',
  'skills',
  'mcpServers',
  'channels',
  'thirdPartyAgents',
  'acpAgents',
  'nativeCliAgents',
  'capabilities',
  'tools',
  'approvals',
  'memory',
  'graph',
  'mem0',
  'hooks',
  'mcpAtoms',
  'sandbox',
  'usage'
] as const satisfies readonly StudioSectionId[];

export function isStudioSectionId(value: string | null | undefined): value is StudioSectionId {
  return typeof value === 'string' && (STUDIO_SECTION_IDS as readonly string[]).includes(value);
}

export interface StudioSectionItem {
  id: StudioSectionId;
  icon: IconSvgElement;
  i18nKey: WebMessageIdWithoutParams;
}

export const STUDIO_AGENT_SECTIONS: StudioSectionItem[] = [
  { id: 'agents', icon: UserGroupIcon, i18nKey: 'web.studio.allAgents' },
  { id: 'orchestration', icon: NeuralNetworkIcon, i18nKey: 'web.studio.orchestration' }
];

export const STUDIO_CAPABILITY_SECTIONS: StudioSectionItem[] = [
  { id: 'models', icon: CpuIcon, i18nKey: 'web.studio.models' },
  { id: 'atoms', icon: PackageIcon, i18nKey: 'web.studio.atoms' },
  { id: 'skills', icon: PuzzleIcon, i18nKey: 'web.studio.skills' },
  { id: 'channels', icon: MessageSquareCodeIcon, i18nKey: 'web.studio.channels' },
  { id: 'thirdPartyAgents', icon: BotIcon, i18nKey: 'web.studio.thirdPartyAgents' }
];

export const STUDIO_RUNTIME_SECTIONS: StudioSectionItem[] = [
  { id: 'capabilities', icon: GeometricShapesIcon, i18nKey: 'web.studio.capabilities' },
  { id: 'approvals', icon: ShieldHalfIcon, i18nKey: 'web.settings.approvals' },
  // Memory folds the former standalone graph + mem0 sections into tabs (deep links /studio/graph and
  // /studio/mem0 still resolve — they open the matching tab — so those ids stay in the union below).
  { id: 'memory', icon: BrainIcon, i18nKey: 'web.settings.memory' },
  { id: 'hooks', icon: WorkflowSquare01Icon, i18nKey: 'web.studio.hooks' },
  { id: 'sandbox', icon: ShieldHalfIcon, i18nKey: 'web.studio.sandbox' }
];

export const STUDIO_USAGE_SECTION: StudioSectionItem = {
  id: 'usage',
  icon: Activity01Icon,
  i18nKey: 'web.studio.usage'
};
