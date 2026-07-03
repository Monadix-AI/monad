'use client';

// Single chokepoint between the workplace UI and the REAL monad backend.
//
// A project is a Workplace Project resource. Everything below is live:
//   - messages   ← useGetUiItemsInfiniteQuery (persisted) merged with the live
//                  useStreamUiItemsQuery feed (in-flight tokens / streaming).
//   - sendDirective → daemon-side project message routing.
//   - approvals  ← projected UI approval items (oversight gate) → useApproveToolMutation.
//   - activity   ← projected UI tool items (real tool calls).
//   - participants = you + invited Monad/ACP/native CLI agents.
//   - projects   = your Workplace Projects (useListWorkplaceProjectsQuery).

import type { NativeCliSessionView, ProfileView, ProjectId, UIItem, WorkplaceProject } from '@monad/protocol';
import type {
  ActivityRow,
  AgentTask,
  ApprovalView,
  Message,
  Participant,
  Project,
  QuestionView,
  TypingIndicator
} from './types';

import {
  nativeCliSessionSelectors,
  profileSelectors,
  useGetProfileSettingsQuery,
  useListNativeCliSessionsQuery,
  useListProfilesQuery,
  useListWorkplaceProjectsQuery,
  useStreamUiItemsQuery,
  workplaceProjectAdapter,
  workplaceProjectSelectors
} from '@monad/client-rtk';
import { entityAvatarUrl, workplaceProjectMembersExtKey } from '@monad/protocol';
import { useEffect, useMemo, useState } from 'react';

import { useAcpAgentSettings } from '@/hooks/use-acp-agent-settings';
import { useFirstItemIndex } from '@/hooks/use-first-item-index';
import { useNativeCliAgentSettings } from '@/hooks/use-native-cli-agent-settings';
import { useTranscriptHistory } from '@/hooks/use-transcript-history';
import { getWorkplaceProjectName } from '@/lib/workspace-sessions';
import {
  __workplaceProjectMessageTest,
  acpProgressText,
  avatarForAgent,
  buildNativeCliStreams,
  buildProjectMessages,
  fmtTime,
  HUMAN,
  iconForAgent,
  initials,
  isManagedNativeCliReasoningOnlyMessage,
  messageToView,
  nativeCliApprovalName,
  nativeCliAvatarSeed,
  nativeCliMemberActivityPhase,
  nativeCliMemberPresence,
  nativeCliProductDisplayName,
  nativeCliProjectMemberAvatarSeed,
  nativeCliSessionIsGenerating,
  nativeCliTag,
  parseProjectMembers,
  productIcon,
  projectMemberId,
  projectMemberParticipants,
  projectMemberStableId,
  summarizeTool,
  toolItems
} from './project-projection';
import { useNativeCliActivityOverrides } from './use-native-cli-activity-overrides';
import { useProjectActions } from './use-project-actions';
import { DEV_SYSTEM_MESSAGES_IN_STREAM_ENABLED, useWorkplaceUiStore } from './workplace-ui-store';

export type { ApprovalDecision } from './use-project-actions';

export { __workplaceProjectMessageTest, acpProgressText, nativeCliAvatarSeed, projectMemberParticipants };

const EMPTY_PROFILES: ProfileView[] = [];
const EMPTY_ITEMS: UIItem[] = [];
const EMPTY_NATIVE_CLI_SESSIONS: NativeCliSessionView[] = [];

const messageId = (m: Message): string => m.id;

export function useProject(projectId: string) {
  const [resolvedProjectId, setResolvedProjectId] = useState<ProjectId | null>(null);

  // --- projects ---
  const { data: projectData } = useListWorkplaceProjectsQuery(undefined);
  const { data: userProfile } = useGetProfileSettingsQuery();
  const { data: profileData } = useListProfilesQuery(undefined);
  const workplaceProjects: WorkplaceProject[] = useMemo(
    () => workplaceProjectSelectors.selectAll(projectData?.projects ?? workplaceProjectAdapter.getInitialState()),
    [projectData]
  );
  const modelProfiles = useMemo(
    () => (profileData ? profileSelectors.selectAll(profileData.profiles) : EMPTY_PROFILES),
    [profileData]
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: projectId is the route param that resets the resolved project session.
  useEffect(() => {
    setResolvedProjectId(null);
  }, [projectId]);

  useEffect(() => {
    const existing = workplaceProjects.find((project) => project.id === projectId);
    if (existing) {
      if (resolvedProjectId !== existing.id) setResolvedProjectId(existing.id);
      return;
    }
    if (projectData && resolvedProjectId !== null) setResolvedProjectId(null);
  }, [projectData, projectId, workplaceProjects, resolvedProjectId]);

  const currentProject = useMemo(
    () => (resolvedProjectId ? (workplaceProjects.find((project) => project.id === resolvedProjectId) ?? null) : null),
    [workplaceProjects, resolvedProjectId]
  );
  const activeProjectId = currentProject?.id ?? null;

  // --- live stream + lazy older history ---
  const stream = useStreamUiItemsQuery(activeProjectId ?? ('prj_' as ProjectId), { skip: activeProjectId === null });
  const nativeCliSessionsQ = useListNativeCliSessionsQuery(activeProjectId ?? ('prj_' as ProjectId), {
    skip: activeProjectId === null
  });
  const transcript = useTranscriptHistory({
    transcriptTargetId: activeProjectId,
    streamOldestCursor: stream.data?.oldestCursor,
    streamHasMore: stream.data?.hasMore ?? false
  });

  // --- invite backend (real) ---
  const acp = useAcpAgentSettings();
  const nativeCli = useNativeCliAgentSettings();
  const projectMembers = useMemo(
    () => parseProjectMembers(currentProject?.origin?.ext?.[workplaceProjectMembersExtKey]),
    [currentProject?.origin?.ext]
  );
  const human = useMemo((): Participant => {
    const name = userProfile?.displayName ?? HUMAN.name;
    return {
      ...HUMAN,
      av: initials(name),
      name,
      avatarUrl: userProfile?.avatarDataUrl ?? entityAvatarUrl(`user:${name}`, userProfile?.avatarStyle)
    };
  }, [userProfile?.avatarDataUrl, userProfile?.avatarStyle, userProfile?.displayName]);
  const nativeCliAvatarSeeds = useMemo(() => {
    const seeds = new Map<string, string>();
    for (const member of projectMembers) {
      if (member.type !== 'native-cli') continue;
      const displayName = member.displayName ?? member.name;
      seeds.set(displayName, nativeCliProjectMemberAvatarSeed(currentProject?.id ?? projectId, member));
    }
    return seeds;
  }, [currentProject?.id, projectId, projectMembers]);
  const nativeCliTags = useMemo(() => {
    const tags = new Map<string, string>();
    for (const member of projectMembers) {
      if (member.type !== 'native-cli') continue;
      const templateName = member.templateName ?? member.name;
      const displayName = member.displayName ?? member.name;
      const agent = nativeCli.agents.find((candidate) => candidate.name === templateName);
      tags.set(displayName, nativeCliTag(agent?.provider));
    }
    return tags;
  }, [nativeCli.agents, projectMembers]);
  const nativeCliDisplayNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const member of projectMembers) {
      if (member.type !== 'native-cli') continue;
      const displayName = member.displayName ?? member.name;
      names.set(projectMemberStableId(member), displayName);
      names.set(member.name, displayName);
    }
    return names;
  }, [projectMembers]);

  // --- participants ---
  const liveItems = stream.data?.items ?? EMPTY_ITEMS;
  const nativeCliSessions = useMemo(
    () =>
      nativeCliSessionsQ.data
        ? nativeCliSessionSelectors.selectAll(nativeCliSessionsQ.data)
        : EMPTY_NATIVE_CLI_SESSIONS,
    [nativeCliSessionsQ.data]
  );
  const contextUsage = liveItems.find(
    (item): item is Extract<UIItem, { kind: 'context' }> => item.kind === 'context'
  )?.usage;
  const liveTools = useMemo(() => toolItems(liveItems), [liveItems]);
  const nativeCliActivityOverrides = useNativeCliActivityOverrides(liveTools);
  const nativeCliStreamingAgentNames = useMemo(() => {
    const names = new Set<string>();
    for (const item of liveItems) {
      if (item.kind !== 'message') continue;
      if (item.source !== 'managed-native-cli' || item.status !== 'streaming') continue;
      if (item.agentName) names.add(item.agentName);
    }
    return names;
  }, [liveItems]);
  const nativeCliActiveAgentNames = useMemo(() => {
    const names = new Set(nativeCliStreamingAgentNames);
    for (const agentName of Object.keys(nativeCliActivityOverrides)) names.add(agentName);
    for (const session of nativeCliSessions) {
      if (nativeCliSessionIsGenerating(session)) names.add(session.agentName);
    }
    return names;
  }, [nativeCliActivityOverrides, nativeCliSessions, nativeCliStreamingAgentNames]);
  const monadStreaming = liveItems.some(
    (item) =>
      item.kind === 'message' &&
      item.status === 'streaming' &&
      item.role === 'assistant' &&
      (item.agentName === undefined || item.agentName === 'monad') &&
      item.source !== 'managed-native-cli'
  );
  const runningDelegations = useMemo(() => {
    const names = new Set<string>();
    for (const s of liveTools) {
      if (s.status === 'running' && s.tool === 'agent_acp_delegate') {
        const agent = (s.input as Record<string, unknown> | undefined)?.agent;
        if (typeof agent === 'string') names.add(agent);
      }
      if (s.status === 'running' && s.tool.startsWith('acp:')) {
        const agent = (s.input as Record<string, unknown> | undefined)?.agent;
        if (typeof agent === 'string') names.add(agent);
      }
    }
    return names;
  }, [liveTools]);
  const participants: Participant[] = useMemo(() => {
    const members: Participant[] = projectMembers.map((member) => {
      if (member.type === 'monad') {
        return {
          id: member.id,
          av: 'MO',
          icon: 'monad',
          name: member.name,
          kind: 'agent',
          tag: 'AI',
          role: 'agent',
          presence: monadStreaming ? 'working' : 'online',
          activityPhase: monadStreaming ? 'thinking' : undefined
        };
      }
      if (member.type === 'native-cli') {
        const templateName = member.templateName ?? member.name;
        const displayName = member.displayName ?? member.name;
        const agent = nativeCli.agents.find((candidate) => candidate.name === templateName);
        const provider = agent?.provider;
        const stableAgentName = projectMemberStableId(member);
        const presence = nativeCliMemberPresence({
          activeAgentNames: nativeCliActiveAgentNames,
          agentName: stableAgentName,
          enabled: agent?.enabled ?? false,
          nativeCliSessions,
          liveTools
        });
        const activityOverride = nativeCliActivityOverrides[stableAgentName];
        return {
          id: member.id,
          av: initials(displayName),
          icon: productIcon(agent?.productIcon),
          avatarUrl: entityAvatarUrl(nativeCliAvatarSeeds.get(displayName) ?? `native-cli:${displayName}`),
          name: displayName,
          kind: 'agent',
          tag: nativeCliTag(provider),
          role: 'CLI',
          presence,
          activityPhase:
            presence === 'working'
              ? (activityOverride?.phase ??
                nativeCliMemberActivityPhase({
                  agentName: stableAgentName,
                  liveTools,
                  nativeCliSessions
                }) ??
                'thinking')
              : undefined
        };
      }
      const agent = acp.agents.find((candidate) => candidate.name === member.name);
      const icon = productIcon(agent?.productIcon);
      return {
        id: member.id,
        av: initials(member.name),
        icon,
        avatarUrl: icon ? undefined : entityAvatarUrl(`acp:${member.name}`),
        name: member.name,
        kind: 'agent',
        tag: 'ACP',
        role: 'delegate',
        presence: runningDelegations.has(member.name) ? 'working' : agent?.enabled ? 'online' : 'idle',
        activityPhase: runningDelegations.has(member.name) ? 'thinking' : undefined
      };
    });
    return members;
  }, [
    acp.agents,
    nativeCli.agents,
    projectMembers,
    monadStreaming,
    runningDelegations,
    nativeCliSessions,
    liveTools,
    nativeCliActiveAgentNames,
    nativeCliActivityOverrides,
    nativeCliAvatarSeeds
  ]);
  const railAgents = useMemo(() => projectMemberParticipants(participants), [participants]);
  const showDevSystemMessagesInStream = useWorkplaceUiStore((state) => state.showDevSystemMessagesInStream);

  // --- messages (history ⊕ live) ---
  // Persisted history only changes when a page loads, NOT per streamed token. Build its view objects
  // in a memo keyed on history.data so their references stay stable across token updates — that lets
  // React.memo(MessageRow) skip re-rendering every settled message (and re-parsing its markdown) on
  // each token; only the in-flight live message below gets a fresh object.
  const persistedMessages: Message[] = useMemo(() => {
    const out: Message[] = [];
    for (const item of transcript.items) {
      if (item.kind !== 'message') continue;
      if (isManagedNativeCliReasoningOnlyMessage(item)) continue;
      out.push(
        messageToView(item, fmtTime(item.seq), nativeCliAvatarSeeds, nativeCliTags, nativeCliDisplayNames, human)
      );
    }
    return out;
  }, [human, nativeCliAvatarSeeds, nativeCliDisplayNames, nativeCliTags, transcript.items]);

  const messages: Message[] = useMemo(() => {
    return buildProjectMessages({
      persistedMessages,
      nativeCliSessions,
      liveItems,
      liveTools,
      nativeCliAvatarSeeds,
      nativeCliTags,
      nativeCliDisplayNames,
      human,
      showDeveloperOnlyMessages: DEV_SYSTEM_MESSAGES_IN_STREAM_ENABLED && showDevSystemMessagesInStream
    });
  }, [
    persistedMessages,
    liveItems,
    liveTools,
    nativeCliSessions,
    nativeCliAvatarSeeds,
    nativeCliTags,
    nativeCliDisplayNames,
    human,
    showDevSystemMessagesInStream
  ]);

  const firstItemIndex = useFirstItemIndex(messages, messageId);
  const loadOlder = transcript.loadOlder;

  const typingAgentName = [...runningDelegations][0] ?? 'monad';
  const hasStreamingMessage = messages.some((message) => message.streaming && (message.text || message.reasoning));
  const typing: TypingIndicator | null =
    monadStreaming && !hasStreamingMessage
      ? {
          av: avatarForAgent(typingAgentName),
          icon: iconForAgent(typingAgentName),
          avatarUrl: nativeCliAvatarSeeds.has(typingAgentName)
            ? entityAvatarUrl(nativeCliAvatarSeeds.get(typingAgentName) as string)
            : undefined,
          name: typingAgentName,
          detail: 'is working…'
        }
      : null;

  // --- activity (real tool steps) ---
  const activity: ActivityRow[] = useMemo(
    () =>
      liveTools.map((s) => ({
        id: s.id,
        av:
          typeof (s.input as { agent?: unknown } | undefined)?.agent === 'string'
            ? avatarForAgent((s.input as { agent: string }).agent)
            : 'MO',
        ...(typeof (s.input as { agent?: unknown } | undefined)?.agent === 'string'
          ? { agentName: (s.input as { agent: string }).agent }
          : {}),
        tool: s.tool,
        detail: summarizeTool(s.tool, s.input),
        ...(s.output ? { output: s.output } : {}),
        status: s.status
      })),
    [liveTools]
  );
  const nativeCliStreams = useMemo(
    () => buildNativeCliStreams(nativeCliSessions, activity),
    [nativeCliSessions, activity]
  );

  // --- agent tasks (running tool steps) ---
  const tasks: AgentTask[] = useMemo(
    () =>
      liveTools.slice(-6).map((s) => ({
        id: s.id,
        av:
          typeof (s.input as { agent?: unknown } | undefined)?.agent === 'string'
            ? avatarForAgent((s.input as { agent: string }).agent)
            : 'MO',
        title: summarizeTool(s.tool, s.input),
        ...(s.output ? { output: s.output } : {}),
        status: s.status
      })),
    [liveTools]
  );

  // --- approvals (real oversight gate) ---
  const approvals: ApprovalView[] = useMemo(
    () =>
      liveItems
        .filter((item): item is Extract<UIItem, { kind: 'approval' }> => item.kind === 'approval')
        .map((a) => ({
          id: a.id,
          nativeCliSessionId:
            (a.input as { approvalOwnership?: unknown; nativeCliSessionId?: unknown } | undefined)
              ?.approvalOwnership === 'provider-owned' &&
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
            (a.input as { approvalOwnership?: unknown } | undefined)?.approvalOwnership === 'provider-owned'
              ? 'CLI'
              : 'AI',
          tool: a.tool,
          text:
            (a.input as { approvalOwnership?: unknown; text?: unknown } | undefined)?.approvalOwnership ===
              'provider-owned' && typeof (a.input as { text?: unknown }).text === 'string'
              ? ((a.input as { text: string }).text as string)
              : summarizeTool(a.tool, a.input),
          meta: a.key ? `gate: ${a.key}` : a.tool
        })),
    [liveItems]
  );

  const questions: QuestionView[] = useMemo(
    () =>
      liveItems
        .filter((item): item is Extract<UIItem, { kind: 'clarification' }> => item.kind === 'clarification')
        .map((item) => ({
          id: item.id,
          askerName: item.asker?.name ?? 'Agent',
          question: item.question,
          options: item.options ?? [],
          mode: item.mode ?? 'single',
          allowOther: item.allowOther !== false
        })),
    [liveItems]
  );

  // --- projects ---
  const projects: Project[] = useMemo(
    () =>
      workplaceProjects.map((project) => ({
        id: project.id,
        name: getWorkplaceProjectName(project),
        active: project.id === activeProjectId
      })),
    [activeProjectId, workplaceProjects]
  );
  const availableProjectMembers = useMemo(() => {
    const current = new Set(projectMembers.map((member) => member.id));
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
              modelOptions: [] as string[],
              reasoningEfforts: [] as string[],
              icon: 'monad' as const
            }
          ]),
      ...acp.agents
        .filter((agent) => !current.has(projectMemberId('acp', agent.name)))
        .map((agent) => ({
          id: projectMemberId('acp', agent.name),
          type: 'acp' as const,
          name: agent.name,
          label: agent.name,
          tag: 'ACP',
          enabled: agent.enabled,
          modelOptions: [] as string[],
          reasoningEfforts: [] as string[],
          icon: productIcon(agent.productIcon)
        })),
      ...nativeCli.agents.map((agent) => ({
        id: `native-cli-template:${agent.name}`,
        type: 'native-cli' as const,
        name: agent.name,
        label: nativeCliProductDisplayName(productIcon(agent.productIcon), agent.provider, agent.name),
        tag: nativeCliTag(agent.provider),
        enabled: agent.enabled,
        provider: agent.provider,
        modelOptions: agent.modelOptions ?? [],
        reasoningEfforts: agent.reasoningEfforts ?? [],
        icon: productIcon(agent.productIcon)
      }))
    ];
  }, [acp.agents, nativeCli.agents, projectMembers]);

  const {
    sendDirective,
    resolveApproval,
    approveAll,
    answerQuestion,
    pauseAll,
    deleteProject,
    switchProject,
    addProjectMember,
    removeProjectMember,
    updateProjectMemberSettings,
    updateProjectMemberIdentity,
    sendNativeCliInput,
    stopNativeCli,
    setWorkdir
  } = useProjectActions({
    activeProjectId,
    currentProject,
    projectMembers,
    approvals,
    acpAgents: acp.agents,
    nativeCliAgents: nativeCli.agents,
    setResolvedProjectId
  });

  return useMemo(
    () => ({
      projectId,
      activeProjectId,
      ready: activeProjectId !== null,
      // live collections
      projects,
      participants,
      railAgents,
      projectMembers,
      availableProjectMembers,
      messages,
      firstItemIndex,
      loadOlder,
      typing,
      activity,
      nativeCliStreams,
      tasks,
      contextUsage,
      modelProfiles,
      approvals,
      questions,
      workdir: { path: currentProject?.cwd, set: setWorkdir },
      paused: false,
      mentionTargets: railAgents.map((a) => ({ id: a.id, name: a.name })),
      // actions
      sendDirective,
      resolveApproval,
      approveAll,
      answerQuestion,
      pauseAll,
      deleteProject,
      switchProject,
      addProjectMember,
      removeProjectMember,
      updateProjectMemberSettings,
      updateProjectMemberIdentity,
      sendNativeCliInput,
      stopNativeCli
    }),
    [
      activeProjectId,
      projectId,
      projects,
      participants,
      railAgents,
      projectMembers,
      availableProjectMembers,
      messages,
      firstItemIndex,
      loadOlder,
      typing,
      activity,
      nativeCliStreams,
      tasks,
      contextUsage,
      modelProfiles,
      approvals,
      questions,
      currentProject?.cwd,
      setWorkdir,
      sendDirective,
      resolveApproval,
      approveAll,
      answerQuestion,
      pauseAll,
      deleteProject,
      switchProject,
      addProjectMember,
      removeProjectMember,
      updateProjectMemberSettings,
      updateProjectMemberIdentity,
      sendNativeCliInput,
      stopNativeCli
    ]
  );
}

export type ProjectController = ReturnType<typeof useProject>;
