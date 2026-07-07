import type { AcpAgentConfig, ExternalAgentConfig, McpServerConfig } from '@monad/home';
import type { Session, SessionMcpServer, TranscriptTarget, WorkplaceProjectMemberSettings } from '@monad/protocol';

import { workplaceProjectMembersExtKey, workplaceProjectMembersExtSchema } from '@monad/protocol';

import { sessionMcpServersToAcp, toAcpMcpServers } from '@/services/delegation/acp-delegate.ts';

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

export function workplaceProjectMembers(session: TranscriptTarget) {
  const parsed = workplaceProjectMembersExtSchema.safeParse(session.origin?.ext?.[workplaceProjectMembersExtKey]);
  return parsed.success ? parsed.data : [];
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
  session: TranscriptTarget,
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
  const parsed = workplaceProjectMembersExtSchema.safeParse(session.origin?.ext?.[workplaceProjectMembersExtKey]);
  if (!parsed.success) return {};
  const member = parsed.data.find(
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

export function externalAgentProjectMemberDisplayNameForAgent(session: TranscriptTarget, agentName: string): string {
  const parsed = workplaceProjectMembersExtSchema.safeParse(session.origin?.ext?.[workplaceProjectMembersExtKey]);
  if (!parsed.success) return agentName;
  const member = parsed.data.find(
    (candidate) =>
      candidate.type === 'external-agent' &&
      (externalAgentProjectMemberRuntimeName(candidate) === agentName ||
        externalAgentProjectMemberTemplateName(candidate) === agentName)
  );
  return member ? externalAgentProjectMemberDisplayName(member) : agentName;
}

export function managedExternalAgentProjectMembers(
  session: TranscriptTarget,
  externalAgents: readonly ExternalAgentConfig[]
): ManagedExternalAgentProjectMember[] {
  const members = workplaceProjectMembers(session);
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

export function projectAcpMembers(session: TranscriptTarget, acpAgents: readonly AcpAgentConfig[]): AcpAgentConfig[] {
  const configured = new Map(acpAgents.map((agent) => [agent.name, agent]));
  return workplaceProjectMembers(session)
    .filter((member) => member.type === 'acp')
    .flatMap((member) => {
      const spec = configured.get(member.name);
      return spec ? [spec] : [];
    });
}
