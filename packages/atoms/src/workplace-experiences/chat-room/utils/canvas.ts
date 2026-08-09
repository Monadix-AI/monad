import type {
  ChannelIcon,
  ContextUsagePayload,
  MessageId,
  NativeAgentDeliveryId,
  ProfileView,
  UIItem,
  UIMessageOutlineItem
} from '@monad/protocol';
import type { WorkplaceApprovalDecision } from '@monad/sdk-experience';
import type { ProjectExperienceCanvasSource } from '../../experience/source.ts';
import type {
  ActivityRow,
  AgentTask,
  ApprovalView,
  MeshAgentStreamView,
  Message,
  Participant,
  ProjectMentionTarget,
  QuestionView,
  TypingIndicator
} from '../../experience/types.ts';

import { entityAvatarUrl, workplaceProjectMemberStableId } from '@monad/protocol';

import { foldMeshAgentExperienceState, meshAgentLifecycleNotices } from '../../experience/mesh-agent-state.ts';
import { productIcon } from '../../experience/project-members.ts';
import {
  avatarForAgent,
  contextUsageFromItems,
  fmtTime,
  iconForAgent,
  projectApprovalViews,
  projectMemberParticipants,
  projectQuestionViews,
  summarizeTool,
  toolItems
} from '../../experience/project-projection.ts';
import { activityRowsFromTools } from '../../shared/utils/activity.ts';
import {
  buildMeshAgentStreams,
  buildProjectMessages,
  isManagedMeshAgentReasoningOnlyMessage,
  messageToView
} from './projection.ts';

export interface ChatRoomCanvas {
  draftKey: string;
  projectId: string;
  activeSessionId: string | null;
  ready: boolean;
  human: Participant;
  messages: Message[];
  participants: Participant[];
  railAgents: Participant[];
  activity: ActivityRow[];
  busy: boolean;
  meshAgentStreams: MeshAgentStreamView[];
  tasks: AgentTask[];
  typing: TypingIndicator | null;
  contextUsage?: ContextUsagePayload;
  modelProfiles: ProfileView[];
  approvals: ApprovalView[];
  questions: QuestionView[];
  mentionTargets: ProjectMentionTarget[];
  /** Load older rows; returns false when no load started so the scroll edge stays armed. */
  loadOlder: () => boolean;
  /** Load newer rows; returns false when no load started so the scroll edge stays armed. */
  loadNewer: () => boolean;
  jumpToLive: () => void;
  transcriptMode: 'history' | 'live';
  messageOutline: readonly UIMessageOutlineItem[];
  /** Brand marks by channel type, for rendering a message's delivery origin. */
  channelIcons?: ReadonlyMap<string, ChannelIcon>;
  openAtMessage?: (messageId: MessageId, options?: { targetVisible?: boolean }) => Promise<boolean>;
  replyTargets: ReadonlyMap<string, Message | null>;
  openAgentCard?: (id: string) => void;
  followMeshSession?: (id: string, deliveryId?: NativeAgentDeliveryId) => void;
  sendDirective: import('./composer.ts').ProjectComposerSurface['sendDirective'];
  resolveApproval: (requestId: string, decision: WorkplaceApprovalDecision) => void;
  answerQuestion: (requestId: string, answer: string) => void;
  pauseAll: () => void;
  sendMeshAgentInput: (id: string, input: string) => Promise<void>;
  stopMeshAgent: (id: string) => Promise<void>;
}

export type ChatRoomCanvasSource = ProjectExperienceCanvasSource;

export function toChatRoomCanvas(
  c: ChatRoomCanvasSource,
  actions?: Pick<ChatRoomCanvas, 'followMeshSession' | 'openAgentCard'>
): ChatRoomCanvas {
  const source = c.source;
  const meshAgentState = source.meshAgentState ? foldMeshAgentExperienceState(source.meshAgentState) : undefined;
  const rawLiveItems = source.liveItems;
  const rawLiveTools = source.liveTools ?? toolItems(rawLiveItems);
  const genericLiveItems = meshAgentState
    ? rawLiveItems.filter((item) => {
        if (item.kind === 'tool') return !item.tool.startsWith('mesh-agent:');
        if (item.kind === 'custom') return !item.name.startsWith('mesh.');
        if (item.kind === 'system') return !item.id.startsWith('mesh-agent-');
        if (item.kind === 'approval') {
          return (item.input as { approvalOwnership?: unknown } | undefined)?.approvalOwnership !== 'provider-owned';
        }
        return true;
      })
    : rawLiveItems;
  const liveItems: readonly UIItem[] = meshAgentState
    ? [
        ...genericLiveItems,
        ...[...meshAgentState.loginRequirements.values()].map((requirement) => ({
          kind: 'custom' as const,
          id: requirement.id,
          name: 'mesh.login_required',
          status: 'error' as const,
          data: requirement,
          seq: requirement.observedAt
        })),
        ...meshAgentLifecycleNotices(meshAgentState).map((notice) => ({
          kind: 'system' as const,
          id: notice.id,
          text: notice.text,
          event: notice.event,
          level: notice.tone === 'warning' ? ('warn' as const) : notice.tone,
          seq: notice.observedAt
        }))
      ]
    : genericLiveItems;
  const liveTools = meshAgentState ? rawLiveTools.filter((tool) => !tool.tool.startsWith('mesh-agent:')) : rawLiveTools;
  const meshSessions = meshAgentState ? [...meshAgentState.sessions.values()] : source.meshSessions;
  const chronologicalItems =
    c.transcriptMode === 'history' ? source.transcriptItems : [...source.transcriptItems, ...liveItems];
  const chronologicalLiveTools = c.transcriptMode === 'history' ? [] : liveTools;
  const busy = projectCanvasIsBusy(liveItems, liveTools, meshAgentState);
  const meshAgentIcons = new Map(source.meshAgentIcons ?? []);
  for (const session of source.meshSessions) meshAgentIcons.set(session.agentName, productIcon(session.productIcon));
  const persistedMessages = source.transcriptItems
    .filter((item) => item.kind === 'message')
    .filter((item) => !isManagedMeshAgentReasoningOnlyMessage(item))
    .map((item) =>
      messageToView(
        item,
        fmtTime(item.seq),
        source.meshAgentAvatarSeeds,
        source.meshAgentTags,
        source.meshAgentDisplayNames,
        meshAgentIcons,
        source.human,
        source.avatarStyle
      )
    );
  const messages = buildProjectMessages({
    persistedMessages,
    projectMembers: c.projectMembers,
    meshSessions,
    liveItems: chronologicalItems,
    liveTools: chronologicalLiveTools,
    meshAgentAvatarSeeds: source.meshAgentAvatarSeeds,
    meshAgentTags: source.meshAgentTags,
    meshAgentDisplayNames: source.meshAgentDisplayNames,
    meshAgentIcons,
    human: source.human,
    avatarStyle: source.avatarStyle,
    showDeveloperOnlyMessages: source.showDeveloperOnlyMessages
  });
  const replyTargets = new Map<string, Message | null>();
  for (const [id, item] of c.replyTargets ?? []) {
    replyTargets.set(
      id,
      item
        ? messageToView(
            item,
            fmtTime(item.seq),
            source.meshAgentAvatarSeeds,
            source.meshAgentTags,
            source.meshAgentDisplayNames,
            meshAgentIcons,
            source.human,
            source.avatarStyle
          )
        : null
    );
  }
  const activity = activityRowsFromTools(liveTools);
  const railAgents = projectMemberParticipants(c.participants);
  const meshAgentTemplateAgentNames = new Map(
    (c.projectMembers ?? [])
      .filter((member) => member.type === 'mesh-agent')
      .map((member) => [workplaceProjectMemberStableId(member), member.templateName ?? member.name])
  );
  const meshAgentAliases = new Map<string, string[]>();
  for (const member of c.projectMembers ?? []) {
    if (member.type !== 'mesh-agent') continue;
    const stableId = workplaceProjectMemberStableId(member);
    const aliases = [stableId, member.name, member.displayName, member.templateName].filter((value): value is string =>
      Boolean(value)
    );
    for (const alias of aliases) meshAgentAliases.set(alias, aliases);
  }
  const meshAgentStreams = buildMeshAgentStreams(meshSessions, activity, meshAgentTemplateAgentNames, meshAgentAliases);
  const tasks: AgentTask[] = liveTools.slice(-6).map((s) => ({
    id: s.id,
    av:
      typeof (s.input as { agent?: unknown } | undefined)?.agent === 'string'
        ? avatarForAgent((s.input as { agent: string }).agent)
        : 'MO',
    title: summarizeTool(s.tool, s.input),
    ...(s.output ? { output: s.output } : {}),
    status: s.status
  }));
  const monadStreaming = liveItems?.some(
    (item) =>
      item.kind === 'message' &&
      item.status === 'streaming' &&
      item.role === 'assistant' &&
      (item.agentName === undefined || item.agentName === 'monad') &&
      item.source !== 'managed-mesh-agent'
  );
  const runningDelegation = liveTools?.find((s) => {
    if (s.status !== 'running') return false;
    return s.tool === 'agent_acp_delegate' || s.tool.startsWith('acp:');
  });
  const delegationInput = runningDelegation?.input as { agent?: unknown } | undefined;
  const typingAgentName = typeof delegationInput?.agent === 'string' ? delegationInput.agent : 'monad';
  const hasStreamingMessage = messages.some((message) => message.streaming && (message.text || message.reasoning));
  const typing =
    monadStreaming && !hasStreamingMessage
      ? {
          av: avatarForAgent(typingAgentName),
          icon: iconForAgent(typingAgentName),
          avatarUrl: source.meshAgentAvatarSeeds.has(typingAgentName)
            ? entityAvatarUrl(source.meshAgentAvatarSeeds.get(typingAgentName) as string, source.avatarStyle)
            : undefined,
          name: typingAgentName,
          detail: 'is working…'
        }
      : null;
  return {
    draftKey: `chat-room:${c.activeSessionId ?? c.projectId}`,
    projectId: c.projectId,
    activeSessionId: c.activeSessionId,
    ready: c.ready,
    human: source.human,
    messages,
    participants: c.participants,
    railAgents,
    activity,
    busy,
    meshAgentStreams,
    tasks,
    typing,
    contextUsage: contextUsageFromItems(liveItems),
    modelProfiles: c.modelProfiles,
    approvals: projectApprovalViews(liveItems, meshAgentState ? [...meshAgentState.approvals.values()] : []),
    questions: projectQuestionViews(liveItems),
    mentionTargets: railAgents.map((agent) => ({ id: agent.id, name: agent.name })),
    loadOlder: c.loadOlder,
    loadNewer: c.loadNewer,
    jumpToLive: c.jumpToLive,
    transcriptMode: c.transcriptMode,
    messageOutline: c.messageOutline ?? [],
    ...(source.channelIcons ? { channelIcons: source.channelIcons } : {}),
    openAtMessage: c.openAtMessage,
    replyTargets,
    followMeshSession: actions?.followMeshSession,
    openAgentCard: actions?.openAgentCard,
    sendDirective: c.sendDirective,
    resolveApproval: c.resolveApproval,
    answerQuestion: c.answerQuestion,
    pauseAll: c.pauseAll,
    sendMeshAgentInput: c.sendMeshAgentInput,
    stopMeshAgent: c.stopMeshAgent
  };
}

export function projectCanvasIsBusy(
  liveItems: readonly UIItem[],
  liveTools: readonly Extract<UIItem, { kind: 'tool' }>[],
  meshAgentState?: {
    activeMeshSessionIds: ReadonlySet<string>;
    approvals: ReadonlyMap<string, unknown>;
  }
): boolean {
  return (
    (meshAgentState?.activeMeshSessionIds.size ?? 0) > 0 ||
    (meshAgentState?.approvals.size ?? 0) > 0 ||
    liveItems.some((item) => {
      if (item.kind === 'message' || item.kind === 'custom') return item.status === 'streaming';
      if (item.kind === 'tool') return item.status === 'running';
      return item.kind === 'approval' || item.kind === 'clarification';
    }) ||
    liveTools.some((tool) => tool.status === 'running')
  );
}
