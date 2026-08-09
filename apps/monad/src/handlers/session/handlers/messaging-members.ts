import type { AcpAgentConfig, McpServerConfig, MeshAgentConfig } from '@monad/environment';
import type { Session, SessionId, SessionMcpServer, WorkplaceProjectMemberSettings } from '@monad/protocol';
import type { Store } from '#/store/db/index.ts';

import { normalizeManagedMeshAgentDirectTarget } from '#/handlers/session/handlers/messaging-notices.ts';
import { sessionMcpServersToAcp, toAcpMcpServers } from '#/services/delegation/acp-delegate.ts';

const CONTROL_ROOM_SESSION_PREFIX = 'Control Room: ';
const WORKPLACE_SESSION_PREFIX = 'Workplace: ';

export type MeshAgentProjectMemberShape = {
  memberId: string;
  templateId?: string;
  type: string;
  name: string;
  templateName?: string;
  displayName?: string;
  instanceId?: string;
  settings?: WorkplaceProjectMemberSettings;
};

export interface ManagedMeshAgentProjectMember {
  spec: MeshAgentConfig;
  // Stable collaboration identity of the member. runtimeAgentName currently equals this value; callers
  // (e.g. S2 runtime ownership) must thread projectMemberId explicitly rather than re-deriving identity
  // from the runtime name, since one Profile can back multiple members.
  projectMemberId: string;
  runtimeAgentName: string;
  templateAgentName: string;
  displayName: string;
  configuredDisplayName?: string;
  settings: Pick<
    WorkplaceProjectMemberSettings,
    | 'cwd'
    | 'managedProjectAgent'
    | 'allowAutopilot'
    | 'modelName'
    | 'modelId'
    | 'reasoningEffort'
    | 'speed'
    | 'customPrompt'
  >;
}

export interface UnavailableManagedMeshAgentProjectMember {
  projectMemberId: string;
  runtimeAgentName: string;
  templateAgentName: string;
  displayName: string;
  provider: MeshAgentConfig['provider'];
  code: 'provider_disabled' | 'provider_unavailable';
  reason: string;
}

// Stable machine code for an ambiguous mesh-agent routing target. Shared by the resolver's typed error,
// the forward transcript-error surface, and (later) the native-agent RPC Handler('conflict') mapping so
// every transport reports the same code — never a per-handler literal that can drift.
export const AMBIGUOUS_MEMBER_TARGET_CODE = 'AMBIGUOUS_MEMBER_TARGET';

// A mesh-agent routing target (the "agentName" from a request) matched an ALIAS that resolves to more than
// one ProjectMember — one Profile can back several members, so a runtime/template/display alias is inherently
// ambiguous. Raised by resolveManagedMember; handlers surface it through their own error exit rather than
// the resolver assuming a presentation. Carries a stable `code` so extractError/HandlerError read it
// directly instead of each caller re-supplying a fallback literal.
export class AmbiguousMemberTargetError extends Error {
  readonly code = AMBIGUOUS_MEMBER_TARGET_CODE;
  constructor(
    readonly requestedId: string,
    readonly matchedMemberIds: string[]
  ) {
    super(`Ambiguous mesh-agent target "${requestedId}" matches ${matchedMemberIds.length} project members`);
    this.name = 'AmbiguousMemberTargetError';
  }
}

// Resolve a routing target to a single managed member with ProjectMember identity as the source of truth.
// An exact projectMemberId is the unambiguous match and always wins. Otherwise an alias (runtimeAgentName,
// templateAgentName, or displayName) must resolve to exactly ONE member — an alias shared by several members
// from one Profile throws AmbiguousMemberTargetError instead of silently taking the first. Returns undefined
// when nothing matches (a not-found the caller handles, not a conflict).
export function resolveManagedMember<
  T extends { projectMemberId: string; runtimeAgentName: string; templateAgentName: string; displayName: string }
>(candidates: readonly T[], requestedId: string): T | undefined {
  const exact = candidates.find((candidate) => candidate.projectMemberId === requestedId);
  if (exact) return exact;
  const aliasMatches = candidates.filter(
    (candidate) =>
      candidate.runtimeAgentName === requestedId ||
      candidate.templateAgentName === requestedId ||
      candidate.displayName === requestedId
  );
  if (aliasMatches.length === 0) return undefined;
  if (aliasMatches.length > 1) {
    // Sort the reported ids so the diagnostic is stable regardless of candidate/DB return order — an
    // ambiguous target must produce the same conflict every time, never a set that reorders per query.
    throw new AmbiguousMemberTargetError(
      requestedId,
      aliasMatches.map((candidate) => candidate.projectMemberId).sort()
    );
  }
  return aliasMatches[0];
}

// A direct-message target is either a canonical project member or a free-form private label (the private
// ledger an agent keeps with a non-member, e.g. a human — delivered nowhere). Kept as a discriminated union
// so callers branch on the kind explicitly rather than guessing from an id shape that has no reliable syntax.
export type DirectMessageTarget =
  | { kind: 'project_member'; projectMemberId: string }
  | { kind: 'private_label'; label: string };

interface DirectMemberCandidate {
  projectMemberId: string;
  runtimeAgentName: string;
  templateAgentName: string;
  displayName: string;
}

// The session's direct-message members, resolved from the CANONICAL identity graph only: a non-left
// SessionBinding joined to its ProjectMember (mesh-agent). Existence is never inferred from a legacy
// session_members row — after the Track B cutover a legacy-only row with no binding is graph corruption, not
// a deliverable member. Each member's provider spec is resolved from its ProjectMember.profileId, which is
// EITHER a project template id (invited/bound members) OR a spec name (ad-hoc spawn) — so an addressable
// alias is the real `spec.name`, and a member with an enabled spec is a startable managed member rather than
// a synthetic unavailable one. `left` bindings and non-managed members are excluded.
export function canonicalDirectMembers(
  store: Store,
  sessionId: SessionId,
  meshAgents: readonly MeshAgentConfig[]
): { available: ManagedMeshAgentProjectMember[]; unavailable: UnavailableManagedMeshAgentProjectMember[] } {
  const available: ManagedMeshAgentProjectMember[] = [];
  const unavailable: UnavailableManagedMeshAgentProjectMember[] = [];
  const projectId = store.getSession(sessionId)?.projectId;
  if (!projectId) return { available, unavailable };
  const configuredByName = new Map(meshAgents.map((agent) => [agent.name, agent]));
  for (const binding of store.listSessionBindings(sessionId)) {
    if (binding.lifecycle === 'left') continue;
    const member = store.getProjectMember(projectId, binding.projectMemberId);
    if (member?.type !== 'mesh-agent' || member.launchOverrides.managedProjectAgent === false) continue;
    const spec = configuredByName.get(member.profileId);
    if (!spec || spec.enabled === false) {
      unavailable.push({
        projectMemberId: member.id,
        runtimeAgentName: member.id,
        templateAgentName: spec?.name ?? member.profileId,
        displayName: member.displayName,
        provider: (spec?.provider ?? member.profileId) as MeshAgentConfig['provider'],
        code: spec ? 'provider_disabled' : 'provider_unavailable',
        reason: spec
          ? `MeshAgent adapter "${spec.name}" is disabled. Enable it in Studio before using it in this project.`
          : `MeshAgent adapter "${member.profileId}" is not configured. Reconnect it in Studio before using it in this project.`
      });
      continue;
    }
    available.push({
      spec,
      projectMemberId: member.id,
      runtimeAgentName: member.id,
      templateAgentName: spec.name,
      displayName: member.displayName,
      configuredDisplayName: member.displayName,
      settings: {
        managedProjectAgent: true,
        ...(member.workingDirectoryOverride ? { cwd: member.workingDirectoryOverride } : {}),
        ...(member.launchOverrides.allowAutopilot !== undefined
          ? { allowAutopilot: member.launchOverrides.allowAutopilot }
          : {}),
        ...(member.launchOverrides.modelName ? { modelName: member.launchOverrides.modelName } : {}),
        ...(member.launchOverrides.modelId ? { modelId: member.launchOverrides.modelId } : {}),
        ...(member.launchOverrides.reasoningEffort ? { reasoningEffort: member.launchOverrides.reasoningEffort } : {}),
        ...(member.launchOverrides.speed ? { speed: member.launchOverrides.speed } : {}),
        ...(member.customPrompt ? { customPrompt: member.customPrompt } : {})
      }
    });
  }
  return { available, unavailable };
}

// Split the session's direct members (available + unavailable) into resolver candidates. A member's own
// canonical fields (pmid, spec.name template alias, displayName) drive resolution; a legacy session_members
// row for the SAME pmid only supplies its runtime instance alias, never a new member.
function activeDirectMessageMembers(
  store: Store,
  sessionId: SessionId,
  meshAgents: readonly MeshAgentConfig[]
): DirectMemberCandidate[] {
  const { available, unavailable } = canonicalDirectMembers(store, sessionId, meshAgents);
  const legacyRuntimeName = new Map(
    workplaceProjectMembers(store, sessionId)
      .filter((member) => member.type === 'mesh-agent')
      .map((member) => [member.memberId, meshAgentProjectMemberRuntimeName(member)] as const)
  );
  return [...available, ...unavailable].map((member) => ({
    projectMemberId: member.projectMemberId,
    runtimeAgentName: legacyRuntimeName.get(member.projectMemberId) ?? member.runtimeAgentName,
    templateAgentName: member.templateAgentName,
    displayName: member.displayName
  }));
}

// Classify a `to`/`with` addressing string at the boundary against the session's canonical members. Exact
// pmid or unique alias → a member; a shared alias → AmbiguousMemberTargetError; anything that matches no
// member → a private label kept verbatim. Only a member target may drive runtime delivery/attribution.
export function resolveDirectMessageTarget(
  store: Store,
  sessionId: SessionId,
  meshAgents: readonly MeshAgentConfig[],
  requestedTarget: string
): DirectMessageTarget {
  const member = resolveManagedMember(
    activeDirectMessageMembers(store, sessionId, meshAgents),
    normalizeManagedMeshAgentDirectTarget(requestedTarget)
  );
  return member
    ? { kind: 'project_member', projectMemberId: member.projectMemberId }
    : { kind: 'private_label', label: requestedTarget };
}

export function isChannelStructuredSession(session: Pick<Session, 'origin' | 'title'>): boolean {
  return (
    session.origin?.client === 'control-room' ||
    session.origin?.client === 'workplace' ||
    session.title.startsWith(CONTROL_ROOM_SESSION_PREFIX) ||
    session.title.startsWith(WORKPLACE_SESSION_PREFIX)
  );
}

export function isWorkplaceProjectTarget(session: Pick<Session, 'origin' | 'title'>): boolean {
  return session.origin?.client === 'workplace' || session.title.startsWith(WORKPLACE_SESSION_PREFIX);
}

export function channelDelegateMcpServers(
  configured: readonly McpServerConfig[] | undefined,
  sessionScoped: readonly SessionMcpServer[] | undefined
) {
  return [...toAcpMcpServers([...(configured ?? [])]), ...sessionMcpServersToAcp([...(sessionScoped ?? [])])];
}

/** A session's live member bindings (Track B `session_members`, not the pre-Track-B
 *  `origin.ext` roster hack) shaped like the legacy `WorkplaceProjectMemberView` so the
 *  rest of this module's helpers stay unchanged. */
export function workplaceProjectMembers(store: Store, sessionId: SessionId): MeshAgentProjectMemberShape[] {
  return store.listSessionMembers(sessionId).map((m) => {
    const data = m.data as {
      name?: string;
      templateName?: string;
      displayName?: string;
      instanceId?: string;
      settings?: WorkplaceProjectMemberSettings;
    };
    return {
      memberId: m.memberId,
      ...(m.templateId ? { templateId: m.templateId } : {}),
      type: m.type,
      name: data.name ?? m.memberId,
      ...(data.templateName ? { templateName: data.templateName } : {}),
      ...(data.displayName ? { displayName: data.displayName } : {}),
      instanceId: data.instanceId ?? m.memberId,
      ...(data.settings ? { settings: data.settings } : {})
    };
  });
}

export function meshAgentProjectMemberTemplateName(member: MeshAgentProjectMemberShape): string {
  return member.type === 'mesh-agent' ? (member.templateName ?? member.name) : member.name;
}

export function meshAgentProjectMemberRuntimeName(member: MeshAgentProjectMemberShape): string {
  return member.type === 'mesh-agent' ? (member.instanceId ?? member.memberId) : member.memberId;
}

export function meshAgentProjectMemberDisplayName(member: MeshAgentProjectMemberShape): string {
  return member.type === 'mesh-agent' ? (member.displayName ?? member.name) : member.name;
}

function matchesMeshAgentProjectMember(member: MeshAgentProjectMemberShape, memberOrTemplateId: string): boolean {
  if (member.memberId === memberOrTemplateId) return true;
  if (member.instanceId === memberOrTemplateId) return true;
  if (member.templateId === memberOrTemplateId) return true;
  return (
    meshAgentProjectMemberRuntimeName(member) === memberOrTemplateId ||
    meshAgentProjectMemberTemplateName(member) === memberOrTemplateId
  );
}

export function meshAgentProjectMemberSettings(
  store: Store,
  sessionId: SessionId,
  memberOrTemplateId: string
): Pick<
  WorkplaceProjectMemberSettings,
  | 'cwd'
  | 'managedProjectAgent'
  | 'allowAutopilot'
  | 'modelName'
  | 'modelId'
  | 'reasoningEffort'
  | 'speed'
  | 'customPrompt'
> {
  const member = workplaceProjectMembers(store, sessionId).find(
    (candidate) => candidate.type === 'mesh-agent' && matchesMeshAgentProjectMember(candidate, memberOrTemplateId)
  );
  if (member?.settings) {
    return {
      managedProjectAgent: member.settings.managedProjectAgent !== false,
      ...(member.settings.cwd?.trim() ? { cwd: member.settings.cwd.trim() } : {}),
      ...(member.settings.allowAutopilot !== undefined ? { allowAutopilot: member.settings.allowAutopilot } : {}),
      ...(member.settings.modelName ? { modelName: member.settings.modelName } : {}),
      ...(member.settings.modelId ? { modelId: member.settings.modelId } : {}),
      ...(member.settings.reasoningEffort ? { reasoningEffort: member.settings.reasoningEffort } : {}),
      ...(member.settings.speed ? { speed: member.settings.speed } : {}),
      ...(member.settings.customPrompt ? { customPrompt: member.settings.customPrompt } : {})
    };
  }
  return member ? { managedProjectAgent: true } : { managedProjectAgent: false };
}

export function meshAgentProjectMemberDisplayNameForAgent(
  store: Store,
  sessionId: SessionId,
  memberOrTemplateId: string
): string {
  const member = workplaceProjectMembers(store, sessionId).find(
    (candidate) => candidate.type === 'mesh-agent' && matchesMeshAgentProjectMember(candidate, memberOrTemplateId)
  );
  return member ? meshAgentProjectMemberDisplayName(member) : memberOrTemplateId;
}

export function meshAgentProjectMemberConfiguredDisplayNameForAgent(
  store: Store,
  sessionId: SessionId,
  memberOrTemplateId: string
): string | undefined {
  return workplaceProjectMembers(store, sessionId).find(
    (candidate) => candidate.type === 'mesh-agent' && matchesMeshAgentProjectMember(candidate, memberOrTemplateId)
  )?.displayName;
}

export function managedMeshAgentProjectMembers(
  store: Store,
  sessionId: SessionId,
  meshAgents: readonly MeshAgentConfig[]
): ManagedMeshAgentProjectMember[] {
  const members = workplaceProjectMembers(store, sessionId);
  const configuredByName = new Map(meshAgents.map((agent) => [agent.name, agent]));
  return members
    .filter((member) => member.type === 'mesh-agent' && member.settings?.managedProjectAgent !== false)
    .flatMap((member) => {
      const templateAgentName = meshAgentProjectMemberTemplateName(member);
      const spec = configuredByName.get(templateAgentName);
      if (!spec || spec.enabled === false) return [];
      return [
        {
          spec,
          projectMemberId: member.memberId,
          runtimeAgentName: meshAgentProjectMemberRuntimeName(member),
          templateAgentName: spec.name,
          displayName: member.displayName ?? spec.displayName ?? member.name,
          configuredDisplayName: member.displayName,
          settings: {
            managedProjectAgent: true,
            ...(member.settings?.cwd?.trim() ? { cwd: member.settings.cwd.trim() } : {}),
            ...(member.settings?.allowAutopilot !== undefined
              ? { allowAutopilot: member.settings.allowAutopilot }
              : {}),
            ...(member.settings?.modelName ? { modelName: member.settings.modelName } : {}),
            ...(member.settings?.modelId ? { modelId: member.settings.modelId } : {}),
            ...(member.settings?.reasoningEffort ? { reasoningEffort: member.settings.reasoningEffort } : {}),
            ...(member.settings?.speed ? { speed: member.settings.speed } : {}),
            ...(member.settings?.customPrompt ? { customPrompt: member.settings.customPrompt } : {})
          }
        }
      ];
    });
}

export function unavailableManagedMeshAgentProjectMembers(
  store: Store,
  sessionId: SessionId,
  meshAgents: readonly MeshAgentConfig[]
): UnavailableManagedMeshAgentProjectMember[] {
  const members = workplaceProjectMembers(store, sessionId);
  const configuredByName = new Map(meshAgents.map((agent) => [agent.name, agent]));
  return members
    .filter((member) => member.type === 'mesh-agent' && member.settings?.managedProjectAgent !== false)
    .flatMap((member): UnavailableManagedMeshAgentProjectMember[] => {
      const templateAgentName = meshAgentProjectMemberTemplateName(member);
      const spec = configuredByName.get(templateAgentName);
      if (!spec) {
        return [
          {
            projectMemberId: member.memberId,
            runtimeAgentName: meshAgentProjectMemberRuntimeName(member),
            templateAgentName,
            displayName: meshAgentProjectMemberDisplayName(member),
            provider: templateAgentName as MeshAgentConfig['provider'],
            code: 'provider_unavailable' as const,
            reason: `MeshAgent adapter "${templateAgentName}" is not configured. Reconnect it in Studio before using it in this project.`
          }
        ];
      }
      if (spec.enabled !== false) return [];
      return [
        {
          projectMemberId: member.memberId,
          runtimeAgentName: meshAgentProjectMemberRuntimeName(member),
          templateAgentName: spec.name,
          displayName: member.displayName ?? spec.displayName ?? member.name,
          provider: spec.provider,
          code: 'provider_disabled' as const,
          reason: `MeshAgent adapter "${spec.name}" is disabled. Enable it in Studio before using it in this project.`
        }
      ];
    });
}

export function projectAcpMembers(
  store: Store,
  sessionId: SessionId,
  acpAgents: readonly AcpAgentConfig[]
): AcpAgentConfig[] {
  const configured = new Map(acpAgents.map((agent) => [agent.name, agent]));
  return workplaceProjectMembers(store, sessionId)
    .filter((member) => member.type === 'acp')
    .flatMap((member) => {
      const spec = configured.get(member.name);
      return spec ? [spec] : [];
    });
}
