import type { WebMessageIdWithoutParams } from '@monad/i18n';
import type { LucideIcon } from 'lucide-react';

import {
  BarChart3,
  Bot,
  Brain,
  Cpu,
  Database,
  MessageSquare,
  MonitorPlay,
  Network,
  Package,
  Plug,
  PlugZap,
  Puzzle,
  ShieldHalf,
  Users,
  Workflow,
  Wrench
} from 'lucide-react';

export type StudioSectionId =
  | 'agents'
  | 'orchestration'
  | 'models'
  | 'atoms'
  | 'skills'
  | 'mcpServers'
  | 'channels'
  | 'acpAgents'
  | 'nativeCliAgents'
  | 'tools'
  | 'browser'
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
  'acpAgents',
  'nativeCliAgents',
  'tools',
  'browser',
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
  { id: 'mcpServers', icon: Plug, i18nKey: 'web.studio.mcpServers' },
  { id: 'mcpAtoms', icon: Plug, i18nKey: 'web.settings.mcpAtoms' },
  { id: 'channels', icon: MessageSquare, i18nKey: 'web.studio.channels' },
  { id: 'acpAgents', icon: Bot, i18nKey: 'web.studio.acpAgents' },
  { id: 'nativeCliAgents', icon: MonitorPlay, i18nKey: 'web.studio.nativeCliAgents' }
];

export const STUDIO_RUNTIME_SECTIONS: StudioSectionItem[] = [
  { id: 'tools', icon: Wrench, i18nKey: 'web.settings.tools' },
  { id: 'browser', icon: MonitorPlay, i18nKey: 'web.settings.browser' },
  { id: 'api', icon: PlugZap, i18nKey: 'web.settings.api' },
  { id: 'approvals', icon: ShieldHalf, i18nKey: 'web.settings.approvals' },
  { id: 'memory', icon: Brain, i18nKey: 'web.settings.memory' },
  { id: 'graph', icon: Network, i18nKey: 'web.settings.graph' },
  { id: 'mem0', icon: Database, i18nKey: 'web.settings.mem0' },
  { id: 'hooks', icon: Workflow, i18nKey: 'web.studio.hooks' },
  { id: 'sandbox', icon: ShieldHalf, i18nKey: 'web.studio.sandbox' }
];

export const STUDIO_USAGE_SECTION: StudioSectionItem = {
  id: 'usage',
  icon: BarChart3,
  i18nKey: 'web.studio.usage'
};
