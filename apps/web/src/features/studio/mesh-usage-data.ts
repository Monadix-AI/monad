import type { MeshAgentUsageResponse, MeshUsageOverviewResponse, ProjectId, SessionId } from '@monad/protocol';

export interface MeshUsageTotals {
  input: number;
  output: number;
  total: number;
}

export interface MeshUsageProviderGroup extends MeshUsageTotals {
  agentCount: number;
  projectIds: ProjectId[];
  provider: string;
  providerUsage: MeshAgentUsageResponse[];
  sessionCount: number;
  topSessions: MeshUsageRankedItem[];
}

export interface MeshUsageRankedItem extends MeshUsageTotals {
  id: string;
  name: string;
  provider?: string;
}

export interface MeshUsageSessionGroup extends MeshUsageTotals {
  agentCount: number;
  projectId: ProjectId | null;
  providerNames: string[];
  sessionId: SessionId;
  sessionTitle: string;
  topAgents: MeshUsageRankedItem[];
}

export interface MeshUsageView {
  agents: number;
  projects: ProjectId[];
  providers: MeshUsageProviderGroup[];
  sessionGroups: MeshUsageSessionGroup[];
  sessions: number;
  totals: MeshUsageTotals;
}

interface ProviderAccumulator extends MeshUsageTotals {
  configuredAgentNames: Set<string>;
  projectIds: Set<ProjectId>;
  provider: string;
  providerUsage: MeshAgentUsageResponse[];
  runtimeAgentIds: Set<string>;
  sessions: Map<SessionId, MeshUsageRankedItem>;
}

interface SessionAccumulator extends MeshUsageTotals {
  agents: Map<string, MeshUsageRankedItem>;
  projectId: ProjectId | null;
  providerNames: Set<string>;
  sessionId: SessionId;
  sessionTitle: string;
}

function addUsage(target: MeshUsageTotals, usage: MeshUsageTotals): void {
  target.total += usage.total;
  target.input += usage.input;
  target.output += usage.output;
}

function newProviderGroup(provider: string): ProviderAccumulator {
  return {
    provider,
    configuredAgentNames: new Set<string>(),
    projectIds: new Set<ProjectId>(),
    providerUsage: [],
    runtimeAgentIds: new Set<string>(),
    sessions: new Map(),
    total: 0,
    input: 0,
    output: 0
  };
}

function newSessionGroup(sessionId: SessionId, sessionTitle: string, projectId: ProjectId | null): SessionAccumulator {
  return {
    sessionId,
    sessionTitle,
    projectId,
    providerNames: new Set<string>(),
    agents: new Map(),
    total: 0,
    input: 0,
    output: 0
  };
}

function addRankedUsage(
  groups: Map<string, MeshUsageRankedItem>,
  id: string,
  name: string,
  usage: MeshUsageTotals,
  provider?: string
): void {
  const group = groups.get(id) ?? { id, name, ...(provider ? { provider } : {}), total: 0, input: 0, output: 0 };
  addUsage(group, usage);
  groups.set(id, group);
}

function topUsage(groups: Map<string, MeshUsageRankedItem>): MeshUsageRankedItem[] {
  return [...groups.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)).slice(0, 3);
}

export function buildMeshUsageView(data: MeshUsageOverviewResponse): MeshUsageView {
  const providers = new Map<string, ProviderAccumulator>();
  const sessions = new Map<SessionId, SessionAccumulator>();
  const configuredAgentNames = new Set<string>();
  const runtimeAgentIds = new Set<string>();
  const projectIds = new Set<ProjectId>();
  const totals: MeshUsageTotals = { total: 0, input: 0, output: 0 };

  for (const snapshot of data.providerUsage) {
    configuredAgentNames.add(`${snapshot.provider}:${snapshot.agentName}`);
    const group = providers.get(snapshot.provider) ?? newProviderGroup(snapshot.provider);
    group.configuredAgentNames.add(snapshot.agentName);
    group.providerUsage.push(snapshot);
    providers.set(snapshot.provider, group);
  }

  for (const snapshot of data.sessionUsage) {
    const runtimeAgentId = snapshot.projectMemberId ?? `${snapshot.provider}:${snapshot.agentName}`;
    runtimeAgentIds.add(runtimeAgentId);
    if (snapshot.projectId) projectIds.add(snapshot.projectId);
    addUsage(totals, snapshot);
    const provider = providers.get(snapshot.provider) ?? newProviderGroup(snapshot.provider);
    provider.runtimeAgentIds.add(runtimeAgentId);
    if (snapshot.projectId) provider.projectIds.add(snapshot.projectId);
    addRankedUsage(provider.sessions, snapshot.sessionId, snapshot.sessionTitle, snapshot);
    addUsage(provider, snapshot);
    providers.set(snapshot.provider, provider);

    const session =
      sessions.get(snapshot.sessionId) ??
      newSessionGroup(snapshot.sessionId, snapshot.sessionTitle, snapshot.projectId);
    session.providerNames.add(snapshot.provider);
    addRankedUsage(session.agents, runtimeAgentId, snapshot.agentDisplayName, snapshot, snapshot.provider);
    addUsage(session, snapshot);
    sessions.set(snapshot.sessionId, session);
  }

  return {
    agents: runtimeAgentIds.size || configuredAgentNames.size,
    sessions: sessions.size,
    totals,
    projects: [...projectIds].sort(),
    providers: [...providers.values()]
      .map((group) => {
        const { configuredAgentNames, runtimeAgentIds, sessions: providerSessions, ...totals } = group;
        return {
          ...totals,
          agentCount: runtimeAgentIds.size || configuredAgentNames.size,
          projectIds: [...group.projectIds].sort(),
          providerUsage: [...group.providerUsage].sort((a, b) => a.agentName.localeCompare(b.agentName)),
          sessionCount: providerSessions.size,
          topSessions: topUsage(providerSessions)
        };
      })
      .sort((a, b) => b.total - a.total || a.provider.localeCompare(b.provider)),
    sessionGroups: [...sessions.values()]
      .map((group) => {
        const { agents, ...totals } = group;
        return {
          ...totals,
          agentCount: agents.size,
          providerNames: [...group.providerNames].sort(),
          topAgents: topUsage(agents)
        };
      })
      .sort((a, b) => b.total - a.total || a.sessionTitle.localeCompare(b.sessionTitle))
  };
}
