import type { WebMessageIdWithoutParams } from '@monad/i18n';
import type { LucideIcon } from 'lucide-react';

import {
  BarChart3,
  Bot,
  Brain,
  Cpu,
  MessageSquare,
  Network,
  Package,
  PlugZap,
  Puzzle,
  Shapes,
  ShieldHalf,
  Users,
  Workflow
} from 'lucide-react';

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
  | 'api'
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
  'api',
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
  icon: LucideIcon;
  i18nKey: WebMessageIdWithoutParams;
}

export const STUDIO_AGENT_SECTIONS: StudioSectionItem[] = [
  { id: 'agents', icon: Users, i18nKey: 'web.studio.allAgents' },
  { id: 'orchestration', icon: Network, i18nKey: 'web.studio.orchestration' }
];

export const STUDIO_CAPABILITY_SECTIONS: StudioSectionItem[] = [
  { id: 'models', icon: Cpu, i18nKey: 'web.studio.models' },
  { id: 'atoms', icon: Package, i18nKey: 'web.studio.atoms' },
  { id: 'skills', icon: Puzzle, i18nKey: 'web.studio.skills' },
  { id: 'channels', icon: MessageSquare, i18nKey: 'web.studio.channels' },
  { id: 'thirdPartyAgents', icon: Bot, i18nKey: 'web.studio.thirdPartyAgents' }
];

export const STUDIO_RUNTIME_SECTIONS: StudioSectionItem[] = [
  { id: 'capabilities', icon: Shapes, i18nKey: 'web.studio.capabilities' },
  { id: 'api', icon: PlugZap, i18nKey: 'web.settings.api' },
  { id: 'approvals', icon: ShieldHalf, i18nKey: 'web.settings.approvals' },
  // Memory folds the former standalone graph + mem0 sections into tabs (deep links /studio/graph and
  // /studio/mem0 still resolve — they open the matching tab — so those ids stay in the union below).
  { id: 'memory', icon: Brain, i18nKey: 'web.settings.memory' },
  { id: 'hooks', icon: Workflow, i18nKey: 'web.studio.hooks' },
  { id: 'sandbox', icon: ShieldHalf, i18nKey: 'web.studio.sandbox' }
];

export const STUDIO_USAGE_SECTION: StudioSectionItem = {
  id: 'usage',
  icon: BarChart3,
  i18nKey: 'web.studio.usage'
};
