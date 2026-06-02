import type {
  ProjectMember as ProjectMemberRecord,
  SessionMemberBinding,
  WorkplaceProjectMemberTemplate
} from '@monad/protocol';
import type {
  WorkplaceExperienceAddMemberOptions,
  WorkplaceExperienceMember,
  WorkplaceExperienceMemberCandidate,
  WorkplaceExperienceMemberSettings,
  WorkplaceExperienceMemberType
} from '@monad/sdk-experience';
import type { Participant } from './types.ts';

export { meshAgentProductDisplayName } from '@monad/protocol';

// The member types are the published third-party contract (in @monad/sdk-experience); these aliases keep the
// atoms-internal names while sdk-atom owns the shape. The functions below stay here.
export type ProjectMemberType = WorkplaceExperienceMemberType;
export type ProjectMemberSettings = WorkplaceExperienceMemberSettings;
export type ProjectMember = WorkplaceExperienceMember;
export type AddProjectMemberOptions = WorkplaceExperienceAddMemberOptions;
export type ProjectMemberCandidate = WorkplaceExperienceMemberCandidate;

/** Adapts the project's memberTemplates (Track B: project-level preset catalog, a plain
 *  id/type/name/displayName/settings shape) into the richer ProjectMember view this module's
 *  rendering/identity helpers already expect — `instanceId`/`templateName` are derived from the
 *  template's own stable id/name rather than carried separately, since a template has no
 *  distinct "instance" concept the way a session-bound member does. */
export function parseProjectMembers(memberTemplates: readonly WorkplaceProjectMemberTemplate[]): ProjectMember[] {
  return memberTemplates.map((template) => ({
    id: template.id,
    type: template.type,
    name: template.name,
    ...(template.type === 'mesh-agent' ? { templateName: template.name, instanceId: template.id } : {}),
    ...(template.displayName ? { displayName: template.displayName } : {}),
    ...(template.settings ? { settings: template.settings } : {})
  }));
}

// Recompose the member's settings from its canonical ProjectMember fields — launchOverrides plus the two
// fields the daemon stores separately (cwd = workingDirectoryOverride, customPrompt).
function memberSettings(member: ProjectMemberRecord): ProjectMemberSettings {
  return {
    ...member.launchOverrides,
    ...(member.workingDirectoryOverride ? { cwd: member.workingDirectoryOverride } : {}),
    ...(member.customPrompt ? { customPrompt: member.customPrompt } : {})
  };
}

// Track B compat reshape (client side): a session member arrives as the canonical `{ member, binding }`.
// The mesh-agent `name` is recovered from the member's Profile reference — a template alias resolves via
// memberTemplates, and an ad-hoc spawn's profileId is itself the name. Loop/connection state is no longer
// carried here (the daemon dropped its agentSession projection); online/offline derives from the binding
// in a later pass.
function parseSessionMembers(
  sessionMembers: readonly SessionMemberBinding[],
  memberTemplates: readonly WorkplaceProjectMemberTemplate[]
): ProjectMember[] {
  return sessionMembers.map(({ member, binding }) => {
    const name = memberTemplates.find((template) => template.id === member.profileId)?.name ?? member.profileId;
    const settings = memberSettings(member);
    return {
      id: member.id,
      type: member.type,
      name,
      ...(member.type === 'mesh-agent' ? { templateName: name, instanceId: member.id } : {}),
      displayName: member.displayName,
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
      joinedAt: binding.createdAt
    };
  });
}

export function resolveExperienceProjectMembers(args: {
  activeSessionId: string | null;
  memberTemplates: readonly WorkplaceProjectMemberTemplate[];
  sessionMembers: readonly SessionMemberBinding[];
}): ProjectMember[] {
  return args.activeSessionId
    ? parseSessionMembers(args.sessionMembers, args.memberTemplates)
    : parseProjectMembers(args.memberTemplates);
}

function safeMeshAgentInstanceSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_') || 'cli';
}

export function safeMeshAgentDisplayName(value: string): string {
  return value.replace(/[\\/:\0]/g, '_').trim() || 'CLI';
}

const PRODUCT_ICON_IDS = new Set([
  'codex',
  'claude-code',
  'antigravity',
  'gemini',
  'gemini-cli',
  'qwen',
  'openclaw',
  'hermes',
  'monad'
]);

export function productIcon(value: unknown): Participant['icon'] | undefined {
  return typeof value === 'string' && PRODUCT_ICON_IDS.has(value) ? (value as Participant['icon']) : undefined;
}

export function uniqueMeshAgentDisplayName(baseName: string, members: readonly ProjectMember[]): string {
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

export function renameMeshAgentProjectMemberDisplayName(member: ProjectMember, value?: string): ProjectMember {
  if (member.type !== 'mesh-agent') return member;
  const displayName = safeMeshAgentDisplayName(value?.trim() || member.displayName || member.name);
  return { ...member, displayName };
}

export function meshAgentAvatarSeed(projectId: string, displayName: string): string {
  return ['mesh-agent', `project:${projectId}`, `name:${displayName}`].join('|');
}

export function meshAgentProjectMemberAvatarSeed(projectId: string, member: ProjectMember): string {
  return meshAgentAvatarSeed(projectId, member.displayName ?? member.name);
}

export function projectMemberAvatarSeeds(projectId: string, members: readonly ProjectMember[]): string[] {
  return members.flatMap((member) => {
    if (member.type === 'mesh-agent') return [meshAgentProjectMemberAvatarSeed(projectId, member)];
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
    | Record<never, never>
    | undefined
): ProjectMemberSettings {
  if (type === 'acp') {
    return {
      ...(agent && 'cwd' in agent && agent.cwd ? { cwd: agent.cwd } : {}),
      ...(agent && 'osSandbox' in agent && agent.osSandbox !== undefined ? { osSandbox: agent.osSandbox } : {}),
      ...(agent && 'forwardMcp' in agent && agent.forwardMcp !== undefined ? { forwardMcp: agent.forwardMcp } : {})
    };
  }
  return { managedProjectAgent: true };
}
