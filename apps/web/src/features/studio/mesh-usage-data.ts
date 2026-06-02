import type { MeshAgentUsageResponse, MeshUsageOverviewResponse, ProjectId } from '@monad/protocol';

export interface MeshUsageTotals {
  input: number;
  output: number;
  total: number;
}

export interface MeshUsageProviderGroup extends MeshUsageTotals {
  agentNames: string[];
  projectIds: ProjectId[];
  provider: string;
  providerUsage: MeshAgentUsageResponse[];
  sessionCount: number;
}

interface MeshUsageProjectGroup extends MeshUsageTotals {
  agentNames: string[];
  projectId: ProjectId;
  providerNames: string[];
  sessionCount: number;
}

export interface MeshUsageView {
  agents: number;
  projects: MeshUsageProjectGroup[];
  providers: MeshUsageProviderGroup[];
  sessions: number;
  totals: MeshUsageTotals;
}

interface ProviderAccumulator extends MeshUsageTotals {
  agentNames: Set<string>;
  projectIds: Set<ProjectId>;
  provider: string;
  providerUsage: MeshAgentUsageResponse[];
  sessionCount: number;
}

interface ProjectAccumulator extends MeshUsageTotals {
  agentNames: Set<string>;
  projectId: ProjectId;
  providerNames: Set<string>;
  sessionCount: number;
}

function addUsage(target: MeshUsageTotals, usage: MeshUsageTotals): void {
  target.total += usage.total;
  target.input += usage.input;
  target.output += usage.output;
}

function newProviderGroup(provider: string): ProviderAccumulator {
  return {
    provider,
    agentNames: new Set<string>(),
    projectIds: new Set<ProjectId>(),
    providerUsage: [],
    sessionCount: 0,
    total: 0,
    input: 0,
    output: 0
  };
}

function newProjectGroup(projectId: ProjectId): ProjectAccumulator {
  return {
    projectId,
    providerNames: new Set<string>(),
    agentNames: new Set<string>(),
    sessionCount: 0,
    total: 0,
    input: 0,
    output: 0
  };
}

export function buildMeshUsageView(data: MeshUsageOverviewResponse): MeshUsageView {
  const providers = new Map<string, ProviderAccumulator>();
  const projects = new Map<ProjectId, ProjectAccumulator>();
  const agentNames = new Set<string>();
  const totals: MeshUsageTotals = { total: 0, input: 0, output: 0 };

  for (const snapshot of data.providerUsage) {
    agentNames.add(snapshot.agentName);
    const group = providers.get(snapshot.provider) ?? newProviderGroup(snapshot.provider);
    group.agentNames.add(snapshot.agentName);
    group.providerUsage.push(snapshot);
    providers.set(snapshot.provider, group);
  }

  for (const snapshot of data.sessionUsage) {
    agentNames.add(snapshot.agentName);
    addUsage(totals, snapshot);
    const provider = providers.get(snapshot.provider) ?? newProviderGroup(snapshot.provider);
    provider.agentNames.add(snapshot.agentName);
    if (snapshot.projectId) provider.projectIds.add(snapshot.projectId);
    provider.sessionCount += 1;
    addUsage(provider, snapshot);
    providers.set(snapshot.provider, provider);

    if (!snapshot.projectId) continue;
    const project = projects.get(snapshot.projectId) ?? newProjectGroup(snapshot.projectId);
    project.providerNames.add(snapshot.provider);
    project.agentNames.add(snapshot.agentName);
    project.sessionCount += 1;
    addUsage(project, snapshot);
    projects.set(snapshot.projectId, project);
  }

  return {
    agents: agentNames.size,
    sessions: data.sessionUsage.length,
    totals,
    providers: [...providers.values()]
      .map((group) => ({
        ...group,
        agentNames: [...group.agentNames].sort(),
        projectIds: [...group.projectIds].sort(),
        providerUsage: [...group.providerUsage].sort((a, b) => a.agentName.localeCompare(b.agentName))
      }))
      .sort((a, b) => b.total - a.total || a.provider.localeCompare(b.provider)),
    projects: [...projects.values()]
      .map((group) => ({
        ...group,
        agentNames: [...group.agentNames].sort(),
        providerNames: [...group.providerNames].sort()
      }))
      .sort((a, b) => b.total - a.total || a.projectId.localeCompare(b.projectId))
  };
}
