import type {
  AvatarStyle,
  NativeCliAppServerTransport,
  NativeCliProjectTemplate,
  NativeCliProvider,
  WorkplaceProjectMemberSettings,
  WorkplaceProjectMemberType,
  WorkplaceProjectMemberView
} from '@monad/protocol';
import type { Participant } from './types.ts';

import { entityAvatarWriteUrl, parseWorkplaceProjectMembers } from '@monad/protocol';

export type ProjectMemberType = WorkplaceProjectMemberType;
export type ProjectMemberSettings = WorkplaceProjectMemberSettings;
export type ProjectMember = WorkplaceProjectMemberView;
export type AddProjectMemberOptions = {
  displayName?: string;
  projectTemplateId?: string;
  modelId?: string;
  reasoningEffort?: string;
  speed?: 'standard' | 'fast';
  appServerTransport?: NativeCliAppServerTransport;
  customPrompt?: string;
};
export interface ProjectMemberCandidate {
  id: string;
  type: ProjectMemberType;
  name: string;
  label: string;
  tag: string;
  enabled: boolean;
  modelOptions: string[];
  reasoningEfforts: string[];
  icon?: Participant['icon'];
  provider?: NativeCliProvider;
  supportedAppServerTransports?: NativeCliAppServerTransport[];
  template?: NativeCliProjectTemplate;
}

export function parseProjectMembers(value: unknown): ProjectMember[] {
  return parseWorkplaceProjectMembers(value);
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
  if (product === 'openclaw') return 'OpenClaw';
  if (product === 'hermes') return 'Hermes';
  return fallback;
}

const PRODUCT_ICON_IDS = new Set(['codex', 'claude-code', 'gemini', 'gemini-cli', 'qwen', 'openclaw', 'hermes']);

export function productIcon(value: unknown): Participant['icon'] | undefined {
  return typeof value === 'string' && PRODUCT_ICON_IDS.has(value) ? (value as Participant['icon']) : undefined;
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

export function warmEntityAvatar(seed: string, avatarStyle?: AvatarStyle): void {
  void fetch(entityAvatarWriteUrl(seed, avatarStyle)).catch(() => {});
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
