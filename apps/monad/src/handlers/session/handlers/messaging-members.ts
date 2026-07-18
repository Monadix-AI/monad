import type { AcpAgentConfig, ExternalAgentConfig, McpServerConfig } from '@monad/environment';
import type { Session, SessionId, SessionMcpServer, WorkplaceProjectMemberSettings } from '@monad/protocol';
import type { Store } from '#/store/db/index.ts';

import { sessionMcpServersToAcp, toAcpMcpServers } from '#/services/delegation/acp-delegate.ts';

const CONTROL_ROOM_SESSION_PREFIX = 'Control Room: ';
const WORKPLACE_SESSION_PREFIX = 'Workplace: ';

export type ExternalAgentProjectMemberShape = {
  type: string;
  name: string;
  templateName?: string;
  displayName?: string;
  instanceId?: string;
  settings?: WorkplaceProjectMemberSettings;
};

export interface ManagedExternalAgentProjectMember {
  spec: ExternalAgentConfig;
  runtimeAgentName: string;
  templateAgentName: string;
  displayName: string;
  configuredDisplayName?: string;
  settings: Pick<
    WorkplaceProjectMemberSettings,
    | 'managedProjectAgent'
    | 'launchMode'
    | 'appServerTransport'
    | 'allowAutopilot'
    | 'modelName'
    | 'modelId'
    | 'reasoningEffort'
    | 'speed'
    | 'customPrompt'
  >;
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
export function workplaceProjectMembers(store: Store, sessionId: SessionId): ExternalAgentProjectMemberShape[] {
  return store.listSessionMembers(sessionId).map((m) => {
    const data = m.data as {
      name?: string;
      templateName?: string;
      displayName?: string;
      instanceId?: string;
      settings?: WorkplaceProjectMemberSettings;
    };
    return {
      type: m.type,
      name: data.name ?? m.memberId,
      ...(data.templateName ? { templateName: data.templateName } : {}),
      ...(data.displayName ? { displayName: data.displayName } : {}),
      instanceId: data.instanceId ?? m.memberId,
      ...(data.settings ? { settings: data.settings } : {})
    };
  });
}

export function externalAgentProjectMemberTemplateName(member: ExternalAgentProjectMemberShape): string {
  return member.type === 'external-agent' ? (member.templateName ?? member.name) : member.name;
}

export function externalAgentProjectMemberRuntimeName(member: ExternalAgentProjectMemberShape): string {
  return member.type === 'external-agent' ? (member.instanceId ?? member.name) : member.name;
}

export function externalAgentProjectMemberDisplayName(member: ExternalAgentProjectMemberShape): string {
  return member.type === 'external-agent' ? (member.displayName ?? member.name) : member.name;
}

export function externalAgentProjectMemberSettings(
  store: Store,
  sessionId: SessionId,
  agentName: string
): Pick<
  WorkplaceProjectMemberSettings,
  | 'managedProjectAgent'
  | 'launchMode'
  | 'appServerTransport'
  | 'allowAutopilot'
  | 'modelName'
  | 'modelId'
  | 'reasoningEffort'
  | 'speed'
  | 'customPrompt'
> {
  const member = workplaceProjectMembers(store, sessionId).find(
    (candidate) =>
      candidate.type === 'external-agent' &&
      (externalAgentProjectMemberRuntimeName(candidate) === agentName ||
        externalAgentProjectMemberTemplateName(candidate) === agentName)
  );
  if (member?.settings) {
    return {
      managedProjectAgent: member.settings.managedProjectAgent !== false,
      ...(member.settings.launchMode ? { launchMode: member.settings.launchMode } : {}),
      ...(member.settings.appServerTransport ? { appServerTransport: member.settings.appServerTransport } : {}),
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

export function externalAgentProjectMemberDisplayNameForAgent(
  store: Store,
  sessionId: SessionId,
  agentName: string
): string {
  const member = workplaceProjectMembers(store, sessionId).find(
    (candidate) =>
      candidate.type === 'external-agent' &&
      (externalAgentProjectMemberRuntimeName(candidate) === agentName ||
        externalAgentProjectMemberTemplateName(candidate) === agentName)
  );
  return member ? externalAgentProjectMemberDisplayName(member) : agentName;
}

export function externalAgentProjectMemberConfiguredDisplayNameForAgent(
  store: Store,
  sessionId: SessionId,
  agentName: string
): string | undefined {
  return workplaceProjectMembers(store, sessionId).find(
    (candidate) =>
      candidate.type === 'external-agent' &&
      (externalAgentProjectMemberRuntimeName(candidate) === agentName ||
        externalAgentProjectMemberTemplateName(candidate) === agentName)
  )?.displayName;
}

export function managedExternalAgentProjectMembers(
  store: Store,
  sessionId: SessionId,
  externalAgents: readonly ExternalAgentConfig[]
): ManagedExternalAgentProjectMember[] {
  const members = workplaceProjectMembers(store, sessionId);
  const configured = new Map(externalAgents.map((agent) => [agent.name, agent]));
  return members
    .filter((member) => member.type === 'external-agent' && member.settings?.managedProjectAgent !== false)
    .flatMap((member) => {
      const templateAgentName = externalAgentProjectMemberTemplateName(member);
      const spec = configured.get(templateAgentName);
      if (!spec) return [];
      return [
        {
          spec,
          runtimeAgentName: externalAgentProjectMemberRuntimeName(member),
          templateAgentName,
          displayName: externalAgentProjectMemberDisplayName(member),
          configuredDisplayName: member.displayName,
          settings: {
            managedProjectAgent: true,
            ...(member.settings?.launchMode ? { launchMode: member.settings.launchMode } : {}),
            ...(member.settings?.appServerTransport ? { appServerTransport: member.settings.appServerTransport } : {}),
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
