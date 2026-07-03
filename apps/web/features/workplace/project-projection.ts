import type { NativeCliProvider, UIItem } from '@monad/protocol';
import type { Participant } from './types';

import { entityAvatarUrl } from '@monad/protocol';
import { isProductIconId } from '@monad/ui';

export type {
  AddProjectMemberOptions,
  ProjectMember,
  ProjectMemberSettings,
  ProjectMemberType
} from './project-members';

export {
  nativeCliAgentFacingCommandPhase,
  nativeCliMemberActivityPhase,
  nativeCliMemberPresence,
  nativeCliSessionIsGenerating
} from './native-cli-presence';
export {
  defaultProjectMemberSettings,
  nativeCliAvatarSeed,
  nativeCliProductDisplayName,
  nativeCliProjectMemberAvatarSeed,
  newNativeCliInstanceId,
  parseProjectMembers,
  projectMemberAvatarSeeds,
  projectMemberId,
  projectMemberStableId,
  renameNativeCliProjectMemberDisplayName,
  safeNativeCliDisplayName,
  uniqueNativeCliDisplayName,
  warmEntityAvatar
} from './project-members';

export const HUMAN: Participant = {
  id: 'me',
  av: 'ME',
  avatarUrl: entityAvatarUrl('user:Operator'),
  name: 'Operator',
  kind: 'human',
  tag: 'User',
  role: 'supervisor',
  presence: 'online'
};

export const initials = (name: string): string =>
  name
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .split(/[\s-]+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || name.slice(0, 2).toUpperCase();

export const avatarForAgent = (name: string): string => (name === 'monad' ? 'MO' : initials(name));

export const fmtTime = (iso?: string): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 5);
};

export function projectMemberParticipants(participants: readonly Participant[]): Participant[] {
  return participants.filter((participant) => participant.kind === 'agent');
}

export function productIcon(value: unknown): Participant['icon'] | undefined {
  return typeof value === 'string' && isProductIconId(value) ? value : undefined;
}

export function nativeCliTag(provider: NativeCliProvider | string | undefined): string {
  if (provider === 'codex') return 'Codex';
  if (provider === 'claude-code') return 'Claude';
  if (provider === 'gemini') return 'Gemini';
  if (provider === 'qwen') return 'Qwen';
  return 'CLI';
}

export function nativeCliApprovalName(provider: NativeCliProvider | string | undefined): string {
  if (provider === 'codex') return 'Codex approval';
  if (provider === 'claude-code') return 'Claude Code approval';
  if (provider === 'gemini') return 'Gemini approval';
  if (provider === 'qwen') return 'Qwen approval';
  return 'CLI approval';
}

export function iconForAgent(name: string): Participant['icon'] | undefined {
  if (name === 'monad') return 'monad';
  return undefined;
}

export function toolItems(items: UIItem[]): Extract<UIItem, { kind: 'tool' }>[] {
  return items.filter((item): item is Extract<UIItem, { kind: 'tool' }> => item.kind === 'tool');
}

export function summarizeTool(tool: string, input: unknown): string {
  const a = input as { agent?: string; instruction?: string; path?: string } | undefined;
  if (tool === 'agent_acp_delegate' && a?.agent) return `delegate to ${a.agent}`;
  if (tool.startsWith('acp:') && a?.agent) return `${a.agent} activity`;
  if (tool === 'agent_delegate') return 'delegate to a sub-agent';
  if (a?.path) return `${tool} · ${a.path}`;
  return tool;
}
