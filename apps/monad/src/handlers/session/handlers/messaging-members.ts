import type { AcpAgentConfig, McpServerConfig, NativeCliAgentConfig } from '@monad/home';
import type { Session, SessionMcpServer, TranscriptTarget, WorkplaceProjectMemberSettings } from '@monad/protocol';

import { workplaceProjectMembersExtKey, workplaceProjectMembersExtSchema } from '@monad/protocol';

import { sessionMcpServersToAcp, toAcpMcpServers } from '@/services/delegation/acp-delegate.ts';

const CONTROL_ROOM_SESSION_PREFIX = 'Control Room: ';
const WORKPLACE_SESSION_PREFIX = 'Workplace: ';

export type NativeCliProjectMemberShape = {
  type: string;
  name: string;
  templateName?: string;
  displayName?: string;
  instanceId?: string;
  settings?: WorkplaceProjectMemberSettings;
};

export interface ManagedNativeCliProjectMember {
  spec: NativeCliAgentConfig;
  runtimeAgentName: string;
  templateAgentName: string;
  displayName: string;
  settings: Pick<
    WorkplaceProjectMemberSettings,
    | 'managedProjectAgent'
    | 'launchMode'
    | 'appServerTransport'
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

export function nativeCliProjectMemberTemplateName(member: NativeCliProjectMemberShape): string {
  return member.type === 'native-cli' ? (member.templateName ?? member.name) : member.name;
}

export function nativeCliProjectMemberRuntimeName(member: NativeCliProjectMemberShape): string {
  return member.type === 'native-cli' ? (member.instanceId ?? member.name) : member.name;
}

export function nativeCliProjectMemberDisplayName(member: NativeCliProjectMemberShape): string {
  return member.type === 'native-cli' ? (member.displayName ?? member.name) : member.name;
}

export function nativeCliProjectMemberSettings(
  session: TranscriptTarget,
  agentName: string
): Pick<
  WorkplaceProjectMemberSettings,
  | 'managedProjectAgent'
  | 'launchMode'
  | 'appServerTransport'
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
      candidate.type === 'native-cli' &&
      (nativeCliProjectMemberRuntimeName(candidate) === agentName ||
        nativeCliProjectMemberTemplateName(candidate) === agentName)
  );
  if (member?.settings) {
    return {
      managedProjectAgent: member.settings.managedProjectAgent !== false,
      ...(member.settings.launchMode ? { launchMode: member.settings.launchMode } : {}),
      ...(member.settings.appServerTransport ? { appServerTransport: member.settings.appServerTransport } : {}),
      ...(member.settings.modelName ? { modelName: member.settings.modelName } : {}),
      ...(member.settings.modelId ? { modelId: member.settings.modelId } : {}),
      ...(member.settings.reasoningEffort ? { reasoningEffort: member.settings.reasoningEffort } : {}),
      ...(member.settings.speed ? { speed: member.settings.speed } : {}),
      ...(member.settings.customPrompt ? { customPrompt: member.settings.customPrompt } : {})
    };
  }
  return member ? { managedProjectAgent: true } : { managedProjectAgent: false };
}

export function nativeCliProjectMemberDisplayNameForAgent(session: TranscriptTarget, agentName: string): string {
  const parsed = workplaceProjectMembersExtSchema.safeParse(session.origin?.ext?.[workplaceProjectMembersExtKey]);
  if (!parsed.success) return agentName;
  const member = parsed.data.find(
    (candidate) =>
      candidate.type === 'native-cli' &&
      (nativeCliProjectMemberRuntimeName(candidate) === agentName ||
        nativeCliProjectMemberTemplateName(candidate) === agentName)
  );
  return member ? nativeCliProjectMemberDisplayName(member) : agentName;
}

export function managedNativeCliProjectMembers(
  session: TranscriptTarget,
  nativeCliAgents: readonly NativeCliAgentConfig[]
): ManagedNativeCliProjectMember[] {
  const members = workplaceProjectMembers(session);
  const configured = new Map(nativeCliAgents.map((agent) => [agent.name, agent]));
  return members
    .filter((member) => member.type === 'native-cli' && member.settings?.managedProjectAgent !== false)
    .flatMap((member) => {
      const templateAgentName = nativeCliProjectMemberTemplateName(member);
      const spec = configured.get(templateAgentName);
      if (!spec) return [];
      return [
        {
          spec,
          runtimeAgentName: nativeCliProjectMemberRuntimeName(member),
          templateAgentName,
          displayName: nativeCliProjectMemberDisplayName(member),
          settings: {
            managedProjectAgent: true,
            ...(member.settings?.launchMode ? { launchMode: member.settings.launchMode } : {}),
            ...(member.settings?.appServerTransport ? { appServerTransport: member.settings.appServerTransport } : {}),
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
