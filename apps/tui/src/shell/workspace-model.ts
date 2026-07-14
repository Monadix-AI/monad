import type {
  AgentId,
  CreateProjectSessionRequest,
  CreateSessionRequest,
  CreateWorkplaceProjectRequest,
  ProjectId,
  SessionId,
  UpdateWorkplaceProjectRequest,
  WorkplaceProjectMemberSettings,
  WorkplaceProjectMemberTemplate,
  WorkplaceProjectMemberType
} from '@monad/protocol';

export function plainChatSessions<T extends { projectId?: unknown }>(sessions: readonly T[]): T[] {
  return sessions.filter((session) => session.projectId === null || session.projectId === undefined);
}

export function inboxOpenTarget(item: { projectId?: ProjectId; sessionId: SessionId }): {
  projectId: ProjectId | null;
  sessionId: SessionId;
} {
  return { projectId: item.projectId ?? null, sessionId: item.sessionId };
}

import {
  defaultWorkplaceProjectMemberSettings,
  externalAgentProductDisplayName,
  newExternalAgentInstanceId,
  safeExternalAgentDisplayName,
  uniqueExternalAgentDisplayName,
  workplaceProjectMemberId
} from '@monad/protocol';

export interface ProjectMemberCandidate {
  type: WorkplaceProjectMemberType;
  name: string;
  displayName?: string;
  cwd?: string;
  osSandbox?: boolean;
  forwardMcp?: boolean;
  defaultLaunchMode?: WorkplaceProjectMemberSettings['launchMode'];
  provider?: string;
  productIcon?: string;
}

export function chatCreateRequest(title: string, agentId: AgentId | null): CreateSessionRequest {
  return { title, ...(agentId ? { agentId } : {}) };
}

export function chatAgentLabel(
  agentIds: readonly AgentId[],
  agents: ReadonlyArray<{ id: AgentId; name: string }>
): string {
  const agentId = agentIds[0];
  if (!agentId) return 'Default Agent';
  return agents.find((agent) => agent.id === agentId)?.name ?? 'Unavailable Agent';
}

export function confirmDestructive(
  armedId: string | null,
  selectedId: string
): { armedId: string | null; confirmed: boolean } {
  if (armedId === selectedId) return { armedId: null, confirmed: true };
  return { armedId: selectedId, confirmed: false };
}

export function projectCreateRequest(name: string, cwd: string): CreateWorkplaceProjectRequest | null {
  const title = name.trim();
  if (!title) return null;
  const workdir = cwd.trim();
  return { title, ...(workdir ? { cwd: workdir } : {}) };
}

export function projectUpdateRequest(
  field: 'archived' | 'cwd' | 'title',
  value: boolean | string
): UpdateWorkplaceProjectRequest | null {
  if (field === 'archived') return { archived: Boolean(value) };
  const text = String(value).trim();
  if (field === 'cwd') return { cwd: text || null };
  return text ? { title: text } : null;
}

export function projectSessionCreateRequest(title: string): CreateProjectSessionRequest | null {
  const value = title.trim();
  return value ? { title: value } : null;
}

export function addProjectMemberTemplate(
  existing: readonly WorkplaceProjectMemberTemplate[],
  candidate: ProjectMemberCandidate
): { added: boolean; members: WorkplaceProjectMemberTemplate[] } {
  if (
    candidate.type !== 'external-agent' &&
    existing.some((member) => member.type === candidate.type && member.name === candidate.name)
  ) {
    return { added: false, members: [...existing] };
  }

  const settings = defaultWorkplaceProjectMemberSettings(candidate.type, candidate);
  const settingsField = Object.keys(settings).length > 0 ? { settings } : {};
  if (candidate.type === 'external-agent') {
    const defaultName = externalAgentProductDisplayName(candidate.productIcon, candidate.provider, candidate.name);
    const displayName = safeExternalAgentDisplayName(
      uniqueExternalAgentDisplayName(candidate.displayName?.trim() || defaultName, existing)
    );
    return {
      added: true,
      members: [
        ...existing,
        {
          id: newExternalAgentInstanceId(candidate.name),
          type: candidate.type,
          name: candidate.name,
          displayName,
          ...settingsField
        }
      ]
    };
  }

  return {
    added: true,
    members: [
      ...existing,
      {
        id: workplaceProjectMemberId(candidate.type, candidate.name),
        type: candidate.type,
        name: candidate.name,
        ...settingsField
      }
    ]
  };
}

export function removeProjectMemberTemplate(
  existing: readonly WorkplaceProjectMemberTemplate[],
  id: string
): WorkplaceProjectMemberTemplate[] {
  return existing.filter((member) => member.id !== id);
}
