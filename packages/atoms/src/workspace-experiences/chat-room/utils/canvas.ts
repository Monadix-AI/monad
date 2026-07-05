import type { ContextUsagePayload, NativeAgentDeliveryId, ProfileView } from '@monad/protocol';
import type { ProjectExperienceCanvasSource } from '../../experience/source.ts';
import type {
  ActivityRow,
  AgentTask,
  ApprovalView,
  Message,
  NativeCliStreamView,
  Participant,
  ProjectMentionTarget,
  QuestionView,
  TypingIndicator
} from '../../experience/types.ts';

import { entityAvatarUrl, workplaceProjectMemberStableId } from '@monad/protocol';

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
  buildNativeCliStreams,
  buildProjectMessages,
  isManagedNativeCliReasoningOnlyMessage,
  messageToView
} from './projection.ts';

export interface ChatRoomCanvas {
  projectId: string;
  ready: boolean;
  messages: Message[];
  participants: Participant[];
  railAgents: Participant[];
  activity: ActivityRow[];
  nativeCliStreams: NativeCliStreamView[];
  tasks: AgentTask[];
  typing: TypingIndicator | null;
  contextUsage?: ContextUsagePayload;
  modelProfiles: ProfileView[];
  approvals: ApprovalView[];
  questions: QuestionView[];
  mentionTargets: ProjectMentionTarget[];
  loadOlder: () => void;
  openAgentCard?: (id: string) => void;
  followNativeCliSession?: (id: string, deliveryId?: NativeAgentDeliveryId) => void;
  sendDirective: (text: string) => Promise<void> | void;
  resolveApproval: (requestId: string, decision: 'approve' | 'reject') => void;
  answerQuestion: (requestId: string, answer: string) => void;
  pauseAll: () => void;
  sendNativeCliInput: (id: string, input: string) => Promise<void>;
  stopNativeCli: (id: string) => Promise<void>;
}

export type ChatRoomCanvasSource = ProjectExperienceCanvasSource;

export function toChatRoomCanvas(
  c: ChatRoomCanvasSource,
  actions?: Pick<ChatRoomCanvas, 'followNativeCliSession' | 'openAgentCard'>
): ChatRoomCanvas {
  const source = c.source;
  const liveItems = source.liveItems;
  const liveTools = source.liveTools ?? toolItems(liveItems);
  const nativeCliIcons = new Map(source.nativeCliIcons ?? []);
  for (const session of source.nativeCliSessions)
    nativeCliIcons.set(session.agentName, productIcon(session.productIcon));
  const persistedMessages = source.transcriptItems
    .filter((item) => item.kind === 'message')
    .filter((item) => !isManagedNativeCliReasoningOnlyMessage(item))
    .map((item) =>
      messageToView(
        item,
        fmtTime(item.seq),
        source.nativeCliAvatarSeeds,
        source.nativeCliTags,
        source.nativeCliDisplayNames,
        nativeCliIcons,
        source.human,
        source.avatarStyle
      )
    );
  const messages = buildProjectMessages({
    persistedMessages,
    nativeCliSessions: source.nativeCliSessions,
    liveItems,
    liveTools,
    nativeCliAvatarSeeds: source.nativeCliAvatarSeeds,
    nativeCliTags: source.nativeCliTags,
    nativeCliDisplayNames: source.nativeCliDisplayNames,
    nativeCliIcons,
    human: source.human,
    avatarStyle: source.avatarStyle,
    showDeveloperOnlyMessages: source.showDeveloperOnlyMessages
  });
  const activity = activityRowsFromTools(liveTools);
  const railAgents = projectMemberParticipants(c.participants);
  const nativeCliTemplateAgentNames = new Map(
    (c.projectMembers ?? [])
      .filter((member) => member.type === 'native-cli')
      .map((member) => [workplaceProjectMemberStableId(member), member.templateName ?? member.name])
  );
  const nativeCliStreams = buildNativeCliStreams(source.nativeCliSessions, activity, nativeCliTemplateAgentNames);
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
      item.source !== 'managed-native-cli'
  );
  const runningDelegation = liveTools?.find((s) => {
    if (s.status !== 'running') return false;
    return s.tool === 'agent_acp_delegate' || s.tool.startsWith('acp:');
  });
  const typingAgentName =
    typeof (runningDelegation?.input as { agent?: unknown } | undefined)?.agent === 'string'
      ? ((runningDelegation?.input as { agent: string }).agent ?? 'monad')
      : 'monad';
  const hasStreamingMessage = messages.some((message) => message.streaming && (message.text || message.reasoning));
  const typing =
    monadStreaming && !hasStreamingMessage
      ? {
          av: avatarForAgent(typingAgentName),
          icon: iconForAgent(typingAgentName),
          avatarUrl: source.nativeCliAvatarSeeds.has(typingAgentName)
            ? entityAvatarUrl(source.nativeCliAvatarSeeds.get(typingAgentName) as string, source.avatarStyle)
            : undefined,
          name: typingAgentName,
          detail: 'is working…'
        }
      : null;
  return {
    projectId: c.projectId,
    ready: c.ready,
    messages,
    participants: c.participants,
    railAgents,
    activity,
    nativeCliStreams,
    tasks,
    typing,
    contextUsage: contextUsageFromItems(liveItems),
    modelProfiles: c.modelProfiles,
    approvals: projectApprovalViews(liveItems),
    questions: projectQuestionViews(liveItems),
    mentionTargets: railAgents.map((agent) => ({ id: agent.id, name: agent.name })),
    loadOlder: c.loadOlder,
    followNativeCliSession: actions?.followNativeCliSession,
    openAgentCard: actions?.openAgentCard,
    sendDirective: c.sendDirective,
    resolveApproval: c.resolveApproval,
    answerQuestion: c.answerQuestion,
    pauseAll: c.pauseAll,
    sendNativeCliInput: c.sendNativeCliInput,
    stopNativeCli: c.stopNativeCli
  };
}
