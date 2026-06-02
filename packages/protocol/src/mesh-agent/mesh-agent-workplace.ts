import { z } from 'zod';

import { type MeshAgentProvider, meshAgentNameSchema } from './mesh-agent-config.ts';

export const workplaceProjectMembersExtKey = 'workplaceProjectMembers';
export const workplaceProjectMemberTypeSchema = z.enum(['acp', 'mesh-agent']);
export type WorkplaceProjectMemberType = z.infer<typeof workplaceProjectMemberTypeSchema>;

export const workplaceProjectMemberSettingsSchema = z.object({
  cwd: z.string().optional(),
  osSandbox: z.boolean().optional(),
  forwardMcp: z.boolean().optional(),
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
  name: meshAgentNameSchema,
  templateName: meshAgentNameSchema.optional(),
  projectTemplateId: meshAgentNameSchema.optional(),
  displayName: meshAgentNameSchema.optional(),
  instanceId: meshAgentNameSchema.optional(),
  settings: workplaceProjectMemberSettingsSchema.optional()
});
export type WorkplaceProjectMember = z.infer<typeof workplaceProjectMemberSchema>;

export const workplaceProjectMembersExtSchema = z.array(workplaceProjectMemberSchema);
export type WorkplaceProjectMembersExt = z.infer<typeof workplaceProjectMembersExtSchema>;

export type WorkplaceProjectMemberView = WorkplaceProjectMember & { id: string };

export function workplaceProjectMemberId(type: WorkplaceProjectMemberType, name: string): string {
  return `${type}:${name}`;
}

export function workplaceProjectMemberStableId(member: WorkplaceProjectMember): string {
  return member.type === 'mesh-agent' && member.instanceId
    ? member.instanceId
    : workplaceProjectMemberId(member.type, member.name);
}

export function parseWorkplaceProjectMembers(value: unknown): WorkplaceProjectMemberView[] {
  const parsed = workplaceProjectMembersExtSchema.safeParse(value);
  if (!parsed.success) return [];
  return parsed.data.map((member) => ({ ...member, id: workplaceProjectMemberStableId(member) }));
}

function safeMeshAgentInstanceSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_') || 'cli';
}

export function safeMeshAgentDisplayName(value: string): string {
  return value.replace(/[\\/:\0]/g, '_').trim() || 'CLI';
}

export function meshAgentProductDisplayName(
  productIcon: string | undefined,
  provider: MeshAgentProvider | string | undefined,
  fallback: string
): string {
  const product = productIcon ?? provider;
  if (product === 'codex') return 'OpenAI Codex';
  if (product === 'claude-code') return 'Claude Code';
  if (product === 'antigravity') return 'Antigravity';
  if (product === 'gemini') return 'Gemini CLI';
  if (product === 'qwen') return 'Qwen Code';
  if (product === 'openclaw') return 'OpenClaw';
  if (product === 'hermes') return 'Hermes';
  if (product === 'monad') return 'Monad';
  return fallback;
}

export function uniqueMeshAgentDisplayName(baseName: string, members: readonly WorkplaceProjectMemberView[]): string {
  const used = new Set(members.map((member) => member.displayName ?? member.name));
  if (!used.has(baseName)) return baseName;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseName}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${baseName}-${Date.now().toString(36)}`;
}

export function newMeshAgentInstanceId(templateName: string): string {
  const random =
    globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 12) ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `pmem_${safeMeshAgentInstanceSegment(templateName)}_${random}`;
}

export function renameMeshAgentProjectMemberDisplayName(
  member: WorkplaceProjectMemberView,
  value?: string
): WorkplaceProjectMemberView {
  if (member.type !== 'mesh-agent') return member;
  const displayName = safeMeshAgentDisplayName(value?.trim() || member.displayName || member.name);
  return { ...member, displayName };
}

export function meshAgentProjectMemberAvatarSeed(projectId: string, displayName: string): string {
  return ['mesh-agent', `project:${projectId}`, `name:${displayName}`].join('|');
}

export function workplaceProjectMemberAvatarSeed(projectId: string, member: WorkplaceProjectMemberView): string {
  return meshAgentProjectMemberAvatarSeed(projectId, member.displayName ?? member.name);
}

export function workplaceProjectMemberAvatarSeeds(
  projectId: string,
  members: readonly WorkplaceProjectMemberView[]
): string[] {
  return members.flatMap((member) => {
    if (member.type === 'mesh-agent') return [workplaceProjectMemberAvatarSeed(projectId, member)];
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
    | Record<never, never>
    | undefined
): WorkplaceProjectMemberSettings {
  if (type === 'acp') {
    return {
      ...(agent && 'cwd' in agent && agent.cwd ? { cwd: agent.cwd } : {}),
      ...(agent && 'osSandbox' in agent && agent.osSandbox !== undefined ? { osSandbox: agent.osSandbox } : {}),
      ...(agent && 'forwardMcp' in agent && agent.forwardMcp !== undefined ? { forwardMcp: agent.forwardMcp } : {})
    };
  }
  return { managedProjectAgent: true };
}

// --- Project-level member templates + session-level member bindings ---
// docs/internals/agent-team-runtime/project-sessions.md. A project's `memberTemplates` is a preset catalog
// (config, never itself running anything); a session's members are the live bindings a session
// invites from a template or spawns ad hoc — see `sessionMemberBindingSchema` (the canonical
// `{ member, binding }` wire view) in session-member-binding.ts.

export const workplaceProjectMemberTemplateSchema = z.object({
  id: z.string().min(1),
  type: workplaceProjectMemberTypeSchema,
  name: meshAgentNameSchema,
  displayName: meshAgentNameSchema.optional(),
  settings: workplaceProjectMemberSettingsSchema.optional()
});
export type WorkplaceProjectMemberTemplate = z.infer<typeof workplaceProjectMemberTemplateSchema>;

export const workplaceProjectMemberTemplatesSchema = z.array(workplaceProjectMemberTemplateSchema);
export type WorkplaceProjectMemberTemplates = z.infer<typeof workplaceProjectMemberTemplatesSchema>;

// Invites a member from one of the project's memberTemplates into the target session.
export const inviteSessionMemberRequestSchema = z.object({ templateId: z.string().min(1) });
export type InviteSessionMemberRequest = z.infer<typeof inviteSessionMemberRequestSchema>;

// Spawns an ad-hoc member into just the target session — no templateId link, never touches the
// project's memberTemplates.
export const spawnSessionMemberRequestSchema = z.object({
  type: workplaceProjectMemberTypeSchema,
  name: meshAgentNameSchema,
  displayName: meshAgentNameSchema.optional(),
  settings: workplaceProjectMemberSettingsSchema.optional()
});
export type SpawnSessionMemberRequest = z.infer<typeof spawnSessionMemberRequestSchema>;

export const removeSessionMemberResponseSchema = z.object({ deleted: z.literal(true) });
export type RemoveSessionMemberResponse = z.infer<typeof removeSessionMemberResponseSchema>;
