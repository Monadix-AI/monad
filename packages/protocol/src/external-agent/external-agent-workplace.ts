import { z } from 'zod';

import {
  type ExternalAgentProvider,
  externalAgentAppServerTransportSchema,
  externalAgentLaunchModeSchema,
  externalAgentNameSchema
} from './external-agent-config.ts';

export const workplaceProjectMembersExtKey = 'workplaceProjectMembers';
export const workplaceProjectMemberTypeSchema = z.enum(['monad', 'acp', 'external-agent']);
export type WorkplaceProjectMemberType = z.infer<typeof workplaceProjectMemberTypeSchema>;

export const workplaceProjectMemberSettingsSchema = z.object({
  cwd: z.string().optional(),
  osSandbox: z.boolean().optional(),
  forwardMcp: z.boolean().optional(),
  launchMode: externalAgentLaunchModeSchema.optional(),
  appServerTransport: externalAgentAppServerTransportSchema.optional(),
  // Per-member override of the agent template's autopilot setting. Off (false) + a proxy-capable
  // adapter makes this managed member delegate its provider approvals to the human instead of
  // running unattended.
  allowAutopilot: z.boolean().optional(),
  managedProjectAgent: z.boolean().optional(),
  modelName: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  reasoningEffort: z.string().min(1).optional(),
  speed: z.enum(['standard', 'fast']).optional(),
  customPrompt: z.string().optional()
});
export type WorkplaceProjectMemberSettings = z.infer<typeof workplaceProjectMemberSettingsSchema>;

export const workplaceProjectMemberSchema = z.object({
  type: workplaceProjectMemberTypeSchema,
  name: externalAgentNameSchema,
  templateName: externalAgentNameSchema.optional(),
  projectTemplateId: externalAgentNameSchema.optional(),
  displayName: externalAgentNameSchema.optional(),
  instanceId: externalAgentNameSchema.optional(),
  settings: workplaceProjectMemberSettingsSchema.optional()
});
export type WorkplaceProjectMember = z.infer<typeof workplaceProjectMemberSchema>;

export const workplaceProjectMembersExtSchema = z.array(workplaceProjectMemberSchema);
export type WorkplaceProjectMembersExt = z.infer<typeof workplaceProjectMembersExtSchema>;

export type WorkplaceProjectMemberView = WorkplaceProjectMember & { id: string };

export function workplaceProjectMemberId(type: WorkplaceProjectMemberType, name: string): string {
  if (type === 'monad') return 'monad';
  return `${type}:${name}`;
}

export function workplaceProjectMemberStableId(member: WorkplaceProjectMember): string {
  return member.type === 'external-agent' && member.instanceId
    ? member.instanceId
    : workplaceProjectMemberId(member.type, member.name);
}

export function parseWorkplaceProjectMembers(value: unknown): WorkplaceProjectMemberView[] {
  const parsed = workplaceProjectMembersExtSchema.safeParse(value);
  if (!parsed.success) return [];
  return parsed.data.map((member) => ({ ...member, id: workplaceProjectMemberStableId(member) }));
}

function safeExternalAgentInstanceSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_') || 'cli';
}

export function safeExternalAgentDisplayName(value: string): string {
  return value.replace(/[\\/:\0]/g, '_').trim() || 'CLI';
}

export function externalAgentProductDisplayName(
  productIcon: string | undefined,
  provider: ExternalAgentProvider | string | undefined,
  fallback: string
): string {
  const product = productIcon ?? provider;
  if (product === 'codex') return 'OpenAI Codex';
  if (product === 'claude-code') return 'Claude Code';
  if (product === 'gemini') return 'Gemini CLI';
  if (product === 'qwen') return 'Qwen Code';
  return fallback;
}

export function uniqueExternalAgentDisplayName(
  baseName: string,
  members: readonly WorkplaceProjectMemberView[]
): string {
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

export function renameExternalAgentProjectMemberDisplayName(
  member: WorkplaceProjectMemberView,
  value?: string
): WorkplaceProjectMemberView {
  if (member.type !== 'external-agent') return member;
  const displayName = safeExternalAgentDisplayName(value?.trim() || member.displayName || member.name);
  return { ...member, displayName };
}

export function externalAgentProjectMemberAvatarSeed(projectId: string, displayName: string): string {
  return ['external-agent', `project:${projectId}`, `name:${displayName}`].join('|');
}

export function workplaceProjectMemberAvatarSeed(projectId: string, member: WorkplaceProjectMemberView): string {
  return externalAgentProjectMemberAvatarSeed(projectId, member.displayName ?? member.name);
}

export function workplaceProjectMemberAvatarSeeds(
  projectId: string,
  members: readonly WorkplaceProjectMemberView[]
): string[] {
  return members.flatMap((member) => {
    if (member.type === 'external-agent') return [workplaceProjectMemberAvatarSeed(projectId, member)];
    if (member.type === 'acp') return [`acp:${member.name}`];
    return [];
  });
}

export function defaultWorkplaceProjectMemberSettings(
  type: WorkplaceProjectMemberType,
  agent:
    | {
        cwd?: string;
        osSandbox?: boolean;
        forwardMcp?: boolean;
      }
    | {
        defaultLaunchMode?: WorkplaceProjectMemberSettings['launchMode'];
      }
    | undefined
): WorkplaceProjectMemberSettings {
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
