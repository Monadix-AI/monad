import type {
  NativeCliProvider,
  WorkplaceProjectMember,
  WorkplaceProjectMemberSettings,
  WorkplaceProjectMemberType
} from '@monad/protocol';
import type { Participant } from './types';

import { entityAvatarWriteUrl, workplaceProjectMembersExtSchema } from '@monad/protocol';

export type ProjectMemberType = WorkplaceProjectMemberType;
export type ProjectMemberSettings = WorkplaceProjectMemberSettings;
export type ProjectMember = WorkplaceProjectMember & { id: string };
export type AddProjectMemberOptions = {
  displayName?: string;
  modelId?: string;
  reasoningEffort?: string;
  speed?: 'standard' | 'fast';
  customPrompt?: string;
};

export function projectMemberId(type: ProjectMemberType, name: string): string {
  if (type === 'monad') return 'monad';
  return `${type}:${name}`;
}

export function projectMemberStableId(member: WorkplaceProjectMember): string {
  return member.type === 'native-cli' && member.instanceId
    ? member.instanceId
    : projectMemberId(member.type, member.name);
}

export function parseProjectMembers(value: unknown): ProjectMember[] {
  const parsed = workplaceProjectMembersExtSchema.safeParse(value);
  if (!parsed.success) return [];
  return parsed.data.map((member) => ({ ...member, id: projectMemberStableId(member) }));
}

function safeNativeCliInstanceSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_') || 'cli';
}

export function safeNativeCliDisplayName(value: string): string {
  return value.replace(/[\\/:\0]/g, '_').trim() || 'CLI';
}

export function nativeCliProductDisplayName(
  icon: Participant['icon'] | undefined,
  provider: NativeCliProvider | string | undefined,
  fallback: string
): string {
  const product = icon ?? provider;
  if (product === 'codex') return 'OpenAI Codex';
  if (product === 'claude-code') return 'Claude Code';
  if (product === 'gemini') return 'Gemini CLI';
  if (product === 'qwen') return 'Qwen Code';
  return fallback;
}

export function uniqueNativeCliDisplayName(baseName: string, members: readonly ProjectMember[]): string {
  const used = new Set(members.map((member) => member.name));
  if (!used.has(baseName)) return baseName;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseName}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${baseName}-${Date.now().toString(36)}`;
}

export function newNativeCliInstanceId(templateName: string): string {
  const random =
    globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 12) ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `pmem_${safeNativeCliInstanceSegment(templateName)}_${random}`;
}

export function renameNativeCliProjectMemberDisplayName(member: ProjectMember, value?: string): ProjectMember {
  if (member.type !== 'native-cli') return member;
  const displayName = safeNativeCliDisplayName(value?.trim() || member.displayName || member.name);
  return { ...member, displayName };
}

export function nativeCliAvatarSeed(projectId: string, displayName: string): string {
  return ['native-cli', `project:${projectId}`, `name:${displayName}`].join('|');
}

export function nativeCliProjectMemberAvatarSeed(projectId: string, member: ProjectMember): string {
  return nativeCliAvatarSeed(projectId, member.displayName ?? member.name);
}

export function projectMemberAvatarSeeds(projectId: string, members: readonly ProjectMember[]): string[] {
  return members.flatMap((member) => {
    if (member.type === 'native-cli') return [nativeCliProjectMemberAvatarSeed(projectId, member)];
    if (member.type === 'acp') return [`acp:${member.name}`];
    return [];
  });
}

export function warmEntityAvatar(seed: string): void {
  void fetch(entityAvatarWriteUrl(seed)).catch(() => {});
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
