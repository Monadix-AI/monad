import type {
  AcpAgentView,
  ApprovalScope,
  AvatarStyle,
  InvitableMeshAgent,
  MeshAgentPendingApproval,
  MeshAgentProvider,
  MeshSessionView,
  UIItem,
  WorkplaceProject
} from '@monad/protocol';
import type { ProjectMember, ProjectMemberCandidate } from './project-members.ts';
import type { AgentActivityOverride, ApprovalView, Participant, Project, QuestionView } from './types.ts';

import {
  entityAvatarUrl,
  meshAgentProductDisplayName,
  workplaceProjectMemberAvatarSeed,
  workplaceProjectMemberId,
  workplaceProjectMemberStableId
} from '@monad/protocol';
import { agentProviderTag } from '@monad/ui/components/MemberIdentity';

import { meshAgentIsGenerating, meshAgentMemberActivityPhase, meshAgentMemberPresence } from './mesh-agent-presence.ts';
import { productIcon } from './project-members.ts';

export const HUMAN: Participant = {
  id: 'me',
  av: 'ME',
  avatarUrl: entityAvatarUrl('user:Operator'),
  name: 'Operator',
  kind: 'human',
  tag: 'User',
  role: 'supervisor',
  presence: 'online'
};

export const initials = (name: string): string =>
  name
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .split(/[\s-]+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || name.slice(0, 2).toUpperCase();

export const avatarForAgent = (name: string): string => (name === 'monad' || name === 'Monad' ? 'MO' : initials(name));

export const fmtTime = (iso?: string): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 5);
};

export function projectMemberParticipants(participants: readonly Participant[]): Participant[] {
  return participants.filter((participant) => participant.kind === 'agent');
}

export function meshAgentTag(provider: MeshAgentProvider | string | undefined): string {
  return agentProviderTag(provider);
}

export function meshAgentApprovalName(provider: MeshAgentProvider | string | undefined): string {
  if (provider === 'monad') return 'Monad approval';
  if (provider === 'codex') return 'Codex approval';
  if (provider === 'claude-code') return 'Claude Code approval';
  if (provider === 'gemini') return 'Gemini approval';
  if (provider === 'qwen') return 'Qwen approval';
  return 'CLI approval';
}

function meshAgentMemberDisplayName(
  member: Pick<ProjectMember, 'displayName' | 'name'>,
  agent: Pick<InvitableMeshAgent, 'displayName'> | undefined
): string {
  if (member.displayName && member.displayName !== member.name) return member.displayName;
  return agent?.displayName ?? member.displayName ?? member.name;
}

export function iconForAgent(name: string): Participant['icon'] | undefined {
  if (name === 'monad' || name === 'Monad') return 'monad';
  return undefined;
}

export function toolItems(items: readonly UIItem[]): Extract<UIItem, { kind: 'tool' }>[] {
  return items.filter((item): item is Extract<UIItem, { kind: 'tool' }> => item.kind === 'tool');
}

export function contextUsageFromItems(items: readonly UIItem[]) {
  return items.find((item): item is Extract<UIItem, { kind: 'context' }> => item.kind === 'context')?.usage;
}

export function humanParticipant(args: {
  avatarDataUrl?: string;
  avatarStyle?: AvatarStyle;
  displayName?: string;
}): Participant {
  const name = args.displayName ?? HUMAN.name;
  return {
    ...HUMAN,
    av: initials(name),
    name,
    avatarUrl: args.avatarDataUrl ?? entityAvatarUrl(`user:${name}`, args.avatarStyle)
  };
}

export function projectList(
  projects: readonly WorkplaceProject[],
  args: {
    activeProjectId: string | null;
    projectName: (project: WorkplaceProject) => string;
  }
): Project[] {
  return projects.map((project) => ({
    id: project.id,
    name: args.projectName(project),
    active: project.id === args.activeProjectId
  }));
}

export function summarizeTool(tool: string, input: unknown): string {
  const a = input as { agent?: string; instruction?: string; path?: string } | undefined;
  if (tool === 'agent_acp_delegate' && a?.agent) return `delegate to ${a.agent}`;
  if (tool.startsWith('acp:') && a?.agent) return `${a.agent} activity`;
  if (tool === 'agent_delegate') return 'delegate to a sub-agent';
  if (a?.path) return `${tool} · ${a.path}`;
  return tool;
}

export function projectParticipants(args: {
  acpAgents: readonly AcpAgentView[];
  activeMeshAgentNames?: ReadonlySet<string>;
  avatarStyle?: AvatarStyle;
  liveTools?: readonly Extract<UIItem, { kind: 'tool' }>[];
  loginRequiredAgentNames?: ReadonlySet<string>;
  meshAgentActivityOverrides?: Record<string, AgentActivityOverride>;
  meshAgents: readonly InvitableMeshAgent[];
  meshAgentAvatarSeeds: ReadonlyMap<string, string>;
  meshSessions: MeshSessionView[];
  projectMembers: readonly ProjectMember[];
  runningDelegations?: ReadonlySet<string>;
}): Participant[] {
  const activeMeshAgentNames = args.activeMeshAgentNames ?? new Set<string>();
  const liveTools = args.liveTools ?? [];
  const meshAgentActivityOverrides = args.meshAgentActivityOverrides ?? {};
  const loginRequiredAgentNames = args.loginRequiredAgentNames ?? new Set<string>();
  const runningDelegations = args.runningDelegations ?? new Set<string>();
  return args.projectMembers.map((member) => {
    if (member.type === 'mesh-agent') {
      const templateName = member.templateName ?? member.name;
      const agent = args.meshAgents.find((candidate) => candidate.name === templateName);
      const displayName = meshAgentMemberDisplayName(member, agent);
      const stableAgentName = workplaceProjectMemberStableId(member);
      const presence =
        loginRequiredAgentNames.has(stableAgentName) ||
        loginRequiredAgentNames.has(templateName) ||
        loginRequiredAgentNames.has(member.name)
          ? 'needs-login'
          : meshAgentMemberPresence({
              activeAgentNames: activeMeshAgentNames,
              agentSession: member.agentSession,
              agentName: stableAgentName,
              enabled: agent?.enabled ?? false,
              meshSessions: args.meshSessions,
              liveTools
            });
      const activityOverride = meshAgentActivityOverrides[stableAgentName];
      const activityPhase =
        meshAgentMemberActivityPhase({
          agentSession: member.agentSession,
          agentName: stableAgentName,
          liveTools,
          meshSessions: args.meshSessions
        }) ??
        (member.agentSession ? undefined : activityOverride?.phase) ??
        (member.agentSession ? undefined : activeMeshAgentNames.has(stableAgentName) ? 'thinking' : undefined);
      return {
        id: member.id,
        av: initials(displayName),
        icon: productIcon(agent?.productIcon),
        ...(agent?.icon ? { providerIcon: agent.icon } : {}),
        avatarUrl: entityAvatarUrl(
          args.meshAgentAvatarSeeds.get(displayName) ?? `mesh-agent:${displayName}`,
          args.avatarStyle
        ),
        name: displayName,
        kind: 'agent',
        tag: meshAgentTag(agent?.provider),
        role: 'CLI',
        presence,
        activityPhase,
        metadata: {
          agent: templateName,
          model: member.settings?.modelId ?? member.settings?.modelName,
          effort: member.settings?.reasoningEffort,
          speed: member.settings?.speed ?? 'standard',
          autopilot: member.settings?.allowAutopilot ?? agent?.allowAutopilot ?? true
        }
      };
    }
    const agent = args.acpAgents.find((candidate) => candidate.name === member.name);
    const icon = productIcon(agent?.productIcon);
    return {
      id: member.id,
      av: initials(member.name),
      icon,
      avatarUrl: icon ? undefined : entityAvatarUrl(`acp:${member.name}`, args.avatarStyle),
      name: member.name,
      kind: 'agent',
      tag: 'ACP',
      role: 'delegate',
      presence: runningDelegations.has(member.name) ? 'working' : agent?.enabled ? 'online' : 'idle',
      activityPhase: runningDelegations.has(member.name) ? 'thinking' : undefined
    };
  });
}

export function projectMemberCandidates(args: {
  acpAgents: readonly AcpAgentView[];
  meshAgents: readonly InvitableMeshAgent[];
  projectMembers: readonly ProjectMember[];
}): ProjectMemberCandidate[] {
  const current = new Set(args.projectMembers.map((member) => member.id));
  const meshAgentCandidates = args.meshAgents.map((agent) => ({
    id: `mesh-agent:${agent.name}`,
    type: 'mesh-agent' as const,
    name: agent.name,
    label: agent.displayName ?? meshAgentProductDisplayName(productIcon(agent.productIcon), agent.provider, agent.name),
    tag: meshAgentTag(agent.provider),
    enabled: agent.enabled,
    provider: agent.provider,
    modelOptions: agent.modelOptions ?? [],
    modelOptionDisplayNames: agent.modelOptionDisplayNames,
    speedsByModel: agent.speedsByModel,
    reasoningEfforts: agent.reasoningEfforts ?? [],
    executionCapabilities: {
      autopilot: agent.capabilities?.autopilot === true,
      fastMode: agent.capabilities?.fastMode === true
    },
    agentInstances: agent.capabilities?.agentInstances ?? 'spawned',
    providerIcon: agent.icon,
    icon: productIcon(agent.productIcon)
  }));
  return [
    ...args.acpAgents
      .filter((agent) => !current.has(workplaceProjectMemberId('acp', agent.name)))
      .map((agent) => ({
        id: workplaceProjectMemberId('acp', agent.name),
        type: 'acp' as const,
        name: agent.name,
        label: agent.name,
        tag: 'ACP',
        enabled: agent.enabled,
        modelOptions: [],
        reasoningEfforts: [],
        executionCapabilities: { autopilot: false, fastMode: false },
        icon: productIcon(agent.productIcon)
      })),
    ...meshAgentCandidates
  ];
}

export function projectApprovalViews(
  items: readonly UIItem[],
  meshApprovals: readonly MeshAgentPendingApproval[] = []
): ApprovalView[] {
  const genericApprovals: ApprovalView[] = items
    .filter((item): item is Extract<UIItem, { kind: 'approval' }> => item.kind === 'approval')
    .filter(
      (item) =>
        meshApprovals.length === 0 ||
        (item.input as { approvalOwnership?: unknown } | undefined)?.approvalOwnership !== 'provider-owned'
    )
    .map((a) => ({
      id: a.id,
      meshSessionId:
        (a.input as { approvalOwnership?: unknown; meshSessionId?: unknown } | undefined)?.approvalOwnership ===
          'provider-owned' && typeof (a.input as { meshSessionId?: unknown } | undefined)?.meshSessionId === 'string'
          ? (a.input as { meshSessionId: string }).meshSessionId
          : undefined,
      approvalOwnership:
        (a.input as { approvalOwnership?: unknown } | undefined)?.approvalOwnership === 'provider-owned'
          ? 'provider-owned'
          : undefined,
      av:
        (a.input as { approvalOwnership?: unknown; provider?: unknown } | undefined)?.approvalOwnership ===
          'provider-owned' && typeof (a.input as { provider?: unknown } | undefined)?.provider === 'string'
          ? initials((a.input as { provider: string }).provider)
          : 'MO',
      name:
        (a.input as { approvalOwnership?: unknown; provider?: unknown } | undefined)?.approvalOwnership ===
          'provider-owned' && typeof (a.input as { provider?: unknown } | undefined)?.provider === 'string'
          ? meshAgentApprovalName((a.input as { provider: string }).provider)
          : 'monad',
      tag:
        (a.input as { approvalOwnership?: unknown } | undefined)?.approvalOwnership === 'provider-owned' ? 'CLI' : 'AI',
      tool: a.tool,
      text:
        (a.input as { approvalOwnership?: unknown; text?: unknown } | undefined)?.approvalOwnership ===
          'provider-owned' && typeof (a.input as { text?: unknown }).text === 'string'
          ? ((a.input as { text: string }).text as string)
          : summarizeTool(a.tool, a.input),
      meta: a.key ? `gate: ${a.key}` : a.tool,
      scopes:
        (a.input as { approvalOwnership?: unknown; provider?: unknown } | undefined)?.approvalOwnership ===
          'provider-owned' && (a.input as { provider?: unknown } | undefined)?.provider !== 'monad'
          ? (['once'] satisfies ApprovalScope[])
          : (['once', 'session', 'global'] satisfies ApprovalScope[])
    }));
  return [
    ...genericApprovals,
    ...meshApprovals.map((approval) => ({
      id: approval.requestId,
      meshSessionId: approval.meshSessionId,
      approvalOwnership: 'provider-owned' as const,
      av: initials(approval.provider),
      name: meshAgentApprovalName(approval.provider),
      tag: 'CLI',
      tool: `mesh-agent:${approval.provider}`,
      text:
        approval.provider === 'monad' &&
        typeof approval.data === 'object' &&
        approval.data !== null &&
        typeof (approval.data as { tool?: unknown }).tool === 'string'
          ? (approval.data as { tool: string }).tool
          : approval.text,
      meta: `mesh approval: ${approval.requestId}`,
      scopes:
        approval.provider === 'monad'
          ? (['once', 'session', 'global'] satisfies ApprovalScope[])
          : (['once'] satisfies ApprovalScope[])
    }))
  ];
}

export function projectQuestionViews(items: readonly UIItem[]): QuestionView[] {
  return items
    .filter((item): item is Extract<UIItem, { kind: 'clarification' }> => item.kind === 'clarification')
    .map((item) => ({
      id: item.id,
      askerName: item.asker?.name ?? 'Agent',
      question: item.question,
      ...(item.questions ? { questions: item.questions } : {}),
      options: item.options ?? [],
      mode: item.mode ?? 'single',
      allowOther: item.allowOther !== false
    }));
}

export function projectMeshAgentMetadataMaps(args: {
  meshAgents: readonly InvitableMeshAgent[];
  projectId: string;
  projectMembers: readonly ProjectMember[];
}): {
  avatarSeeds: Map<string, string>;
  displayNames: Map<string, string>;
  icons: Map<string, Participant['icon']>;
  tags: Map<string, string>;
} {
  const avatarSeeds = new Map<string, string>();
  const displayNames = new Map<string, string>();
  const icons = new Map<string, Participant['icon']>();
  const tags = new Map<string, string>();
  for (const member of args.projectMembers) {
    if (member.type !== 'mesh-agent') continue;
    const templateName = member.templateName ?? member.name;
    const agent = args.meshAgents.find((candidate) => candidate.name === templateName);
    const displayName = meshAgentMemberDisplayName(member, agent);
    const stableId = workplaceProjectMemberStableId(member);
    const icon = productIcon(agent?.productIcon);
    const tag = meshAgentTag(agent?.provider);
    avatarSeeds.set(displayName, workplaceProjectMemberAvatarSeed(args.projectId, member));
    displayNames.set(stableId, displayName);
    displayNames.set(member.name, displayName);
    icons.set(stableId, icon);
    icons.set(member.name, icon);
    icons.set(displayName, icon);
    tags.set(stableId, tag);
    tags.set(member.name, tag);
    tags.set(displayName, tag);
  }
  return { avatarSeeds, displayNames, icons, tags };
}

export function meshAgentStreamingAgentNames(items: readonly UIItem[]): Set<string> {
  const names = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'message') continue;
    if (item.source !== 'managed-mesh-agent' || item.status !== 'streaming') continue;
    if (item.agentName) names.add(item.agentName);
  }
  return names;
}

export function activeMeshAgentNames(args: {
  activityOverrideAgentNames: readonly string[];
  liveTools: readonly Extract<UIItem, { kind: 'tool' }>[];
  meshSessions: readonly MeshSessionView[];
  streamingAgentNames: ReadonlySet<string>;
  activeMeshSessionIds?: ReadonlySet<string>;
}): Set<string> {
  const names = new Set(args.streamingAgentNames);
  for (const agentName of args.activityOverrideAgentNames) names.add(agentName);
  for (const session of args.meshSessions) {
    const active = args.activeMeshSessionIds
      ? args.activeMeshSessionIds.has(session.id)
      : meshAgentIsGenerating(session.agentName, args.liveTools, session);
    if (active) {
      names.add(session.agentName);
    }
  }
  return names;
}

export function runningDelegationAgentNames(liveTools: readonly Extract<UIItem, { kind: 'tool' }>[]): Set<string> {
  const names = new Set<string>();
  for (const tool of liveTools) {
    const isDelegation = tool.tool === 'agent_acp_delegate' || tool.tool.startsWith('acp:');
    if (tool.status !== 'running' || !isDelegation) continue;
    const agent = (tool.input as Record<string, unknown> | undefined)?.agent;
    if (typeof agent === 'string') names.add(agent);
  }
  return names;
}
