import type {
  AcpAgentView,
  AvatarStyle,
  NativeCliAgentView,
  NativeCliAppServerTransport,
  NativeCliProvider,
  NativeCliSessionView,
  UIItem,
  WorkplaceProject
} from '@monad/protocol';
import type { ProjectMember, ProjectMemberCandidate } from './project-members.ts';
import type { AgentActivityOverride, ApprovalView, Participant, Project, QuestionView } from './types.ts';

import { entityAvatarUrl } from '@monad/protocol';

import {
  nativeCliMemberActivityPhase,
  nativeCliMemberPresence,
  nativeCliSessionIsGenerating
} from './native-cli-presence.ts';
import {
  nativeCliProductDisplayName,
  nativeCliProjectMemberAvatarSeed,
  productIcon,
  projectMemberId,
  projectMemberStableId
} from './project-members.ts';

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

export const avatarForAgent = (name: string): string => (name === 'monad' ? 'MO' : initials(name));

export const fmtTime = (iso?: string): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 5);
};

export function projectMemberParticipants(participants: readonly Participant[]): Participant[] {
  return participants.filter((participant) => participant.kind === 'agent');
}

export function nativeCliTag(provider: NativeCliProvider | string | undefined): string {
  if (provider === 'codex') return 'Codex';
  if (provider === 'claude-code') return 'Claude';
  if (provider === 'gemini') return 'Gemini';
  if (provider === 'qwen') return 'Qwen';
  return 'CLI';
}

export function nativeCliApprovalName(provider: NativeCliProvider | string | undefined): string {
  if (provider === 'codex') return 'Codex approval';
  if (provider === 'claude-code') return 'Claude Code approval';
  if (provider === 'gemini') return 'Gemini approval';
  if (provider === 'qwen') return 'Qwen approval';
  return 'CLI approval';
}

export function iconForAgent(name: string): Participant['icon'] | undefined {
  if (name === 'monad') return 'monad';
  return undefined;
}

export function toolItems(items: readonly UIItem[]): Extract<UIItem, { kind: 'tool' }>[] {
  return items.filter((item): item is Extract<UIItem, { kind: 'tool' }> => item.kind === 'tool');
}

export function contextUsageFromItems(items: readonly UIItem[]) {
  return items.find((item): item is Extract<UIItem, { kind: 'context' }> => item.kind === 'context')?.usage;
}

export function monadIsStreaming(items: readonly UIItem[]): boolean {
  return items.some(
    (item) =>
      item.kind === 'message' &&
      item.status === 'streaming' &&
      item.role === 'assistant' &&
      (item.agentName === undefined || item.agentName === 'monad') &&
      item.source !== 'managed-native-cli'
  );
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
  activeNativeCliAgentNames?: ReadonlySet<string>;
  avatarStyle?: AvatarStyle;
  liveTools?: readonly Extract<UIItem, { kind: 'tool' }>[];
  monadStreaming?: boolean;
  nativeCliActivityOverrides?: Record<string, AgentActivityOverride>;
  nativeCliAgents: readonly NativeCliAgentView[];
  nativeCliAvatarSeeds: ReadonlyMap<string, string>;
  nativeCliSessions: NativeCliSessionView[];
  projectMembers: readonly ProjectMember[];
  runningDelegations?: ReadonlySet<string>;
}): Participant[] {
  const activeNativeCliAgentNames = args.activeNativeCliAgentNames ?? new Set<string>();
  const liveTools = args.liveTools ?? [];
  const nativeCliActivityOverrides = args.nativeCliActivityOverrides ?? {};
  const runningDelegations = args.runningDelegations ?? new Set<string>();
  return args.projectMembers.map((member) => {
    if (member.type === 'monad') {
      return {
        id: member.id,
        av: 'MO',
        icon: 'monad',
        name: member.name,
        kind: 'agent',
        tag: 'AI',
        role: 'agent',
        presence: args.monadStreaming ? 'working' : 'online',
        activityPhase: args.monadStreaming ? 'thinking' : undefined
      };
    }
    if (member.type === 'native-cli') {
      const templateName = member.templateName ?? member.name;
      const displayName = member.displayName ?? member.name;
      const agent = args.nativeCliAgents.find((candidate) => candidate.name === templateName);
      const stableAgentName = projectMemberStableId(member);
      const presence = nativeCliMemberPresence({
        activeAgentNames: activeNativeCliAgentNames,
        agentName: stableAgentName,
        enabled: agent?.enabled ?? false,
        nativeCliSessions: args.nativeCliSessions,
        liveTools
      });
      const activityOverride = nativeCliActivityOverrides[stableAgentName];
      return {
        id: member.id,
        av: initials(displayName),
        icon: productIcon(agent?.productIcon),
        avatarUrl: entityAvatarUrl(
          args.nativeCliAvatarSeeds.get(displayName) ?? `native-cli:${displayName}`,
          args.avatarStyle
        ),
        name: displayName,
        kind: 'agent',
        tag: nativeCliTag(agent?.provider),
        role: 'CLI',
        presence,
        activityPhase:
          presence === 'working'
            ? (activityOverride?.phase ??
              nativeCliMemberActivityPhase({
                agentName: stableAgentName,
                liveTools,
                nativeCliSessions: args.nativeCliSessions
              }) ??
              'thinking')
            : undefined
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
  nativeCliAgents: readonly NativeCliAgentView[];
  projectMembers: readonly ProjectMember[];
}): ProjectMemberCandidate[] {
  const current = new Set(args.projectMembers.map((member) => member.id));
  const emptyTransports: NativeCliAppServerTransport[] = [];
  return [
    ...(current.has('monad')
      ? []
      : [
          {
            id: 'monad',
            type: 'monad' as const,
            name: 'monad',
            label: 'monad',
            tag: 'AI',
            enabled: true,
            modelOptions: [],
            reasoningEfforts: [],
            supportedAppServerTransports: emptyTransports,
            icon: 'monad' as const
          }
        ]),
    ...args.acpAgents
      .filter((agent) => !current.has(projectMemberId('acp', agent.name)))
      .map((agent) => ({
        id: projectMemberId('acp', agent.name),
        type: 'acp' as const,
        name: agent.name,
        label: agent.name,
        tag: 'ACP',
        enabled: agent.enabled,
        modelOptions: [],
        reasoningEfforts: [],
        supportedAppServerTransports: emptyTransports,
        icon: productIcon(agent.productIcon)
      })),
    ...args.nativeCliAgents.map((agent) => ({
      id: `native-cli-template:${agent.name}`,
      type: 'native-cli' as const,
      name: agent.name,
      label: nativeCliProductDisplayName(productIcon(agent.productIcon), agent.provider, agent.name),
      tag: nativeCliTag(agent.provider),
      enabled: agent.enabled,
      provider: agent.provider,
      modelOptions: agent.modelOptions ?? [],
      reasoningEfforts: agent.reasoningEfforts ?? [],
      supportedAppServerTransports: emptyTransports,
      icon: productIcon(agent.productIcon)
    }))
  ];
}

export function projectApprovalViews(items: readonly UIItem[]): ApprovalView[] {
  return items
    .filter((item): item is Extract<UIItem, { kind: 'approval' }> => item.kind === 'approval')
    .map((a) => ({
      id: a.id,
      nativeCliSessionId:
        (a.input as { approvalOwnership?: unknown; nativeCliSessionId?: unknown } | undefined)?.approvalOwnership ===
          'provider-owned' &&
        typeof (a.input as { nativeCliSessionId?: unknown } | undefined)?.nativeCliSessionId === 'string'
          ? (a.input as { nativeCliSessionId: string }).nativeCliSessionId
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
          ? nativeCliApprovalName((a.input as { provider: string }).provider)
          : 'monad',
      tag:
        (a.input as { approvalOwnership?: unknown } | undefined)?.approvalOwnership === 'provider-owned' ? 'CLI' : 'AI',
      tool: a.tool,
      text:
        (a.input as { approvalOwnership?: unknown; text?: unknown } | undefined)?.approvalOwnership ===
          'provider-owned' && typeof (a.input as { text?: unknown }).text === 'string'
          ? ((a.input as { text: string }).text as string)
          : summarizeTool(a.tool, a.input),
      meta: a.key ? `gate: ${a.key}` : a.tool
    }));
}

export function projectQuestionViews(items: readonly UIItem[]): QuestionView[] {
  return items
    .filter((item): item is Extract<UIItem, { kind: 'clarification' }> => item.kind === 'clarification')
    .map((item) => ({
      id: item.id,
      askerName: item.asker?.name ?? 'Agent',
      question: item.question,
      options: item.options ?? [],
      mode: item.mode ?? 'single',
      allowOther: item.allowOther !== false
    }));
}

export function projectNativeCliMetadataMaps(args: {
  nativeCliAgents: readonly NativeCliAgentView[];
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
    if (member.type !== 'native-cli') continue;
    const templateName = member.templateName ?? member.name;
    const displayName = member.displayName ?? member.name;
    const agent = args.nativeCliAgents.find((candidate) => candidate.name === templateName);
    const stableId = projectMemberStableId(member);
    const icon = productIcon(agent?.productIcon);
    const tag = nativeCliTag(agent?.provider);
    avatarSeeds.set(displayName, nativeCliProjectMemberAvatarSeed(args.projectId, member));
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

export function nativeCliStreamingAgentNames(items: readonly UIItem[]): Set<string> {
  const names = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'message') continue;
    if (item.source !== 'managed-native-cli' || item.status !== 'streaming') continue;
    if (item.agentName) names.add(item.agentName);
  }
  return names;
}

export function activeNativeCliAgentNames(args: {
  activityOverrideAgentNames: readonly string[];
  nativeCliSessions: readonly NativeCliSessionView[];
  streamingAgentNames: ReadonlySet<string>;
}): Set<string> {
  const names = new Set(args.streamingAgentNames);
  for (const agentName of args.activityOverrideAgentNames) names.add(agentName);
  for (const session of args.nativeCliSessions) {
    if (nativeCliSessionIsGenerating(session)) names.add(session.agentName);
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
