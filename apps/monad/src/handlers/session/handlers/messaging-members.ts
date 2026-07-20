import type { AcpAgentConfig, McpServerConfig, MeshAgentConfig } from '@monad/environment';
import type { Session, SessionId, SessionMcpServer, WorkplaceProjectMemberSettings } from '@monad/protocol';
import type { Store } from '#/store/db/index.ts';

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
  runtimeAgentName: string;
  templateAgentName: string;
  displayName: string;
  configuredDisplayName?: string;
  settings: Pick<
    WorkplaceProjectMemberSettings,
    'managedProjectAgent' | 'allowAutopilot' | 'modelName' | 'modelId' | 'reasoningEffort' | 'speed' | 'customPrompt'
  >;
}

export interface UnavailableManagedMeshAgentProjectMember {
  runtimeAgentName: string;
  templateAgentName: string;
  displayName: string;
  provider: MeshAgentConfig['provider'];
  code: 'provider_disabled' | 'provider_unavailable';
  reason: string;
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
  'managedProjectAgent' | 'allowAutopilot' | 'modelName' | 'modelId' | 'reasoningEffort' | 'speed' | 'customPrompt'
> {
  const member = workplaceProjectMembers(store, sessionId).find(
    (candidate) => candidate.type === 'mesh-agent' && matchesMeshAgentProjectMember(candidate, memberOrTemplateId)
  );
  if (member?.settings) {
    return {
      managedProjectAgent: member.settings.managedProjectAgent !== false,
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
  const configuredByTemplateId = new Map(
    meshAgents.flatMap((agent) => (agent.projectTemplates ?? []).map((template) => [template.id, agent] as const))
  );
  return members
    .filter((member) => member.type === 'mesh-agent' && member.settings?.managedProjectAgent !== false)
    .flatMap((member) => {
      const templateAgentName = meshAgentProjectMemberTemplateName(member);
      const spec =
        (member.templateId ? configuredByTemplateId.get(member.templateId) : undefined) ??
        configuredByName.get(templateAgentName);
      if (!spec || spec.enabled === false) return [];
      return [
        {
          spec,
          runtimeAgentName: meshAgentProjectMemberRuntimeName(member),
          templateAgentName: spec.name,
          displayName: meshAgentProjectMemberDisplayName(member),
          configuredDisplayName: member.displayName,
          settings: {
            managedProjectAgent: true,
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
  const configuredByTemplateId = new Map(
    meshAgents.flatMap((agent) => (agent.projectTemplates ?? []).map((template) => [template.id, agent] as const))
  );
  return members
    .filter((member) => member.type === 'mesh-agent' && member.settings?.managedProjectAgent !== false)
    .flatMap((member): UnavailableManagedMeshAgentProjectMember[] => {
      const templateAgentName = meshAgentProjectMemberTemplateName(member);
      const spec =
        (member.templateId ? configuredByTemplateId.get(member.templateId) : undefined) ??
        configuredByName.get(templateAgentName);
      if (!spec) {
        return [
          {
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
          runtimeAgentName: meshAgentProjectMemberRuntimeName(member),
          templateAgentName: spec.name,
          displayName: meshAgentProjectMemberDisplayName(member),
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
