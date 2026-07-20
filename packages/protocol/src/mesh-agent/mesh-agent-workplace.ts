import { z } from 'zod';

import { agentObservationEventSchema } from '../agent-observation.ts';
import { eventIdSchema, iso8601Schema, meshSessionIdSchema, sessionIdSchema } from '../ids.ts';
import { type MeshAgentProvider, meshAgentNameSchema } from './mesh-agent-config.ts';

export const workplaceProjectMembersExtKey = 'workplaceProjectMembers';
export const workplaceProjectMemberTypeSchema = z.enum(['monad', 'acp', 'mesh-agent']);
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
  if (type === 'monad') return 'monad';
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
  if (product === 'gemini') return 'Gemini CLI';
  if (product === 'qwen') return 'Qwen Code';
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
  if (type === 'monad') return {};
  if (type === 'acp') {
    return {
      ...(agent && 'cwd' in agent && agent.cwd ? { cwd: agent.cwd } : {}),
      ...(agent && 'osSandbox' in agent && agent.osSandbox !== undefined ? { osSandbox: agent.osSandbox } : {}),
      ...(agent && 'forwardMcp' in agent && agent.forwardMcp !== undefined ? { forwardMcp: agent.forwardMcp } : {})
    };
  }
  return { managedProjectAgent: true };
}

// --- Track B: project-level member templates + session-level member bindings ---
// docs/proposals/project-session-decoupling.md. A project's `memberTemplates` is a preset catalog
// (config, never itself running anything); a session's members are the live bindings a session
// invites from a template or spawns ad hoc — see workplaceProjectSessionMemberSchema below.

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

// A session's live member binding. `templateId` links back to a workplaceProjectMemberTemplate when
// invited from one; absent for an ad-hoc spawn. Distinct from a template: this carries the runtime
// binding (`meshSessionId`) once running, and is never shared across sessions — inviting
// "the same" template into two sessions produces two independent bindings, each with its own id.
export const workplaceProjectSessionMemberSchema = z.object({
  id: z.string().min(1),
  templateId: z.string().min(1).optional(),
  type: workplaceProjectMemberTypeSchema,
  name: meshAgentNameSchema,
  displayName: meshAgentNameSchema.optional(),
  settings: workplaceProjectMemberSettingsSchema.optional(),
  meshSessionId: meshSessionIdSchema.optional(),
  joinedAt: iso8601Schema.optional()
});
export type WorkplaceProjectSessionMember = z.infer<typeof workplaceProjectSessionMemberSchema>;

export const listSessionMembersResponseSchema = z.object({ members: z.array(workplaceProjectSessionMemberSchema) });
export type ListSessionMembersResponse = z.infer<typeof listSessionMembersResponseSchema>;

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

export const sessionMemberResponseSchema = z.object({ member: workplaceProjectSessionMemberSchema });
export type SessionMemberResponse = z.infer<typeof sessionMemberResponseSchema>;

export const removeSessionMemberResponseSchema = z.object({ deleted: z.literal(true) });
export type RemoveSessionMemberResponse = z.infer<typeof removeSessionMemberResponseSchema>;

// The neutral UI-observation plane for a session member that has no `meshSessionId` of its
// own (today, the `monad`-typed member) — its raw source is the session's own domain event log
// (filtered to the events that member produced) rather than a provider's raw output. It keys on
// `sessionId`+`memberId` because there is no `mesh_` id to key on.
//
// `cursor` is the id of the last domain event folded into this frame (absent when the member has
// produced no events yet) — the same exclusive-cursor primitive `session.subscribe`'s
// `afterEventId` already uses (durable log + in-flight round buffer, see
// `createSessionMemberObservationHandlers`). It is echoed back as the SSE frame's `id:`, so a
// reconnect resumes via `Last-Event-ID`/`?after=` instead of always replaying the whole session.
export const sessionMemberUiObservationFrameSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('live'),
    operation: z.enum(['replace', 'append']),
    sessionId: sessionIdSchema,
    memberId: z.string().min(1),
    events: z.array(agentObservationEventSchema),
    cursor: eventIdSchema.optional(),
    observedAt: z.string()
  }),
  z.object({
    state: z.literal('events'),
    operation: z.enum(['replace', 'append']),
    sessionId: sessionIdSchema,
    memberId: z.string().min(1),
    events: z.array(agentObservationEventSchema),
    cursor: eventIdSchema.optional(),
    observedAt: z.string()
  }),
  z.object({
    state: z.literal('unavailable'),
    sessionId: sessionIdSchema,
    memberId: z.string().min(1),
    reason: z.string()
  })
]);
export type SessionMemberUiObservationFrame = z.infer<typeof sessionMemberUiObservationFrameSchema>;
