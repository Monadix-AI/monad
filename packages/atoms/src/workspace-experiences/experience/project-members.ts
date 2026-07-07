import type { ExternalAgentProvider } from '@monad/protocol';
import type {
  WorkspaceExperienceAddMemberOptions,
  WorkspaceExperienceMember,
  WorkspaceExperienceMemberCandidate,
  WorkspaceExperienceMemberSettings,
  WorkspaceExperienceMemberType
} from '@monad/sdk-atom';
import type { Participant } from './types.ts';

import { parseWorkplaceProjectMembers } from '@monad/protocol';

// The member types are the published third-party contract (in @monad/sdk-atom); these aliases keep the
// atoms-internal names while sdk-atom owns the shape. The functions below stay here.
export type ProjectMemberType = WorkspaceExperienceMemberType;
export type ProjectMemberSettings = WorkspaceExperienceMemberSettings;
export type ProjectMember = WorkspaceExperienceMember;
export type AddProjectMemberOptions = WorkspaceExperienceAddMemberOptions;
export type ProjectMemberCandidate = WorkspaceExperienceMemberCandidate;

export function parseProjectMembers(value: unknown): ProjectMember[] {
  return parseWorkplaceProjectMembers(value);
}

function safeExternalAgentInstanceSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_') || 'cli';
}

export function safeExternalAgentDisplayName(value: string): string {
  return value.replace(/[\\/:\0]/g, '_').trim() || 'CLI';
}

export function externalAgentProductDisplayName(
  icon: Participant['icon'] | undefined,
  provider: ExternalAgentProvider | string | undefined,
  fallback: string
): string {
  const product = icon ?? provider;
  if (product === 'codex') return 'OpenAI Codex';
  if (product === 'claude-code') return 'Claude Code';
  if (product === 'gemini') return 'Gemini CLI';
  if (product === 'qwen') return 'Qwen Code';
  if (product === 'openclaw') return 'OpenClaw';
  if (product === 'hermes') return 'Hermes';
  return fallback;
}

const PRODUCT_ICON_IDS = new Set(['codex', 'claude-code', 'gemini', 'gemini-cli', 'qwen', 'openclaw', 'hermes']);

export function productIcon(value: unknown): Participant['icon'] | undefined {
  return typeof value === 'string' && PRODUCT_ICON_IDS.has(value) ? (value as Participant['icon']) : undefined;
}

export function uniqueExternalAgentDisplayName(baseName: string, members: readonly ProjectMember[]): string {
  const used = new Set(members.map((member) => member.name));
  if (!used.has(baseName)) return baseName;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseName}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${baseName}-${Date.now().toString(36)}`;
}

export function newExternalAgentInstanceId(templateName: string): string {
  const random =
    globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 12) ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `pmem_${safeExternalAgentInstanceSegment(templateName)}_${random}`;
}

export function renameExternalAgentProjectMemberDisplayName(member: ProjectMember, value?: string): ProjectMember {
  if (member.type !== 'external-agent') return member;
  const displayName = safeExternalAgentDisplayName(value?.trim() || member.displayName || member.name);
  return { ...member, displayName };
}

export function externalAgentAvatarSeed(projectId: string, displayName: string): string {
  return ['external-agent', `project:${projectId}`, `name:${displayName}`].join('|');
}

export function externalAgentProjectMemberAvatarSeed(projectId: string, member: ProjectMember): string {
  return externalAgentAvatarSeed(projectId, member.displayName ?? member.name);
}

export function projectMemberAvatarSeeds(projectId: string, members: readonly ProjectMember[]): string[] {
  return members.flatMap((member) => {
    if (member.type === 'external-agent') return [externalAgentProjectMemberAvatarSeed(projectId, member)];
    if (member.type === 'acp') return [`acp:${member.name}`];
    return [];
  });
}

export function defaultProjectMemberSettings(
  type: ProjectMemberType,
  agent:
    | {
        cwd?: string;
        osSandbox?: boolean;
        forwardMcp?: boolean;
      }
    | {
        defaultLaunchMode?: ProjectMemberSettings['launchMode'];
      }
    | undefined
): ProjectMemberSettings {
  if (type === 'monad') return {};
  if (type === 'acp') {
    return {
      ...(agent && 'cwd' in agent && agent.cwd ? { cwd: agent.cwd } : {}),
      ...(agent && 'osSandbox' in agent && agent.osSandbox !== undefined ? { osSandbox: agent.osSandbox } : {}),
      ...(agent && 'forwardMcp' in agent && agent.forwardMcp !== undefined ? { forwardMcp: agent.forwardMcp } : {})
    };
  }
  return {
    ...(agent && 'defaultLaunchMode' in agent && agent.defaultLaunchMode
      ? { launchMode: agent.defaultLaunchMode }
      : {}),
    managedProjectAgent: true
  };
}
