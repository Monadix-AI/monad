import type {
  ContextUsagePayload,
  NativeAgentDeliveryId,
  NativeCliSessionView,
  ProfileView,
  UIItem
} from '@monad/protocol';
import type {
  ActivityRow,
  AgentTask,
  ApprovalView,
  Message,
  NativeCliStreamView,
  Participant,
  QuestionView,
  TypingIndicator
} from '../../types';
import type { ProjectExperienceActions, ProjectExperienceSnapshot, ProjectMentionTarget } from '../contracts';

import { entityAvatarUrl } from '@monad/protocol';

import {
  avatarForAgent,
  fmtTime,
  iconForAgent,
  type ProjectMember,
  projectMemberStableId,
  summarizeTool,
  toolItems
} from '../../project-projection';
import { activityRowsFromTools } from '../shared/activity';
import {
  buildNativeCliStreams,
  buildProjectMessages,
  isManagedNativeCliReasoningOnlyMessage,
  messageToView
} from './projection';

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
  contextUsage: ProjectExperienceSnapshot['contextUsage'];
  modelProfiles: ProjectExperienceSnapshot['modelProfiles'];
  approvals: ApprovalView[];
  questions: QuestionView[];
  mentionTargets: ProjectMentionTarget[];
  loadOlder: () => void;
  openAgentCard?: (id: string) => void;
  followNativeCliSession?: (id: string, deliveryId?: NativeAgentDeliveryId) => void;
  sendDirective: ProjectExperienceActions['sendDirective'];
  resolveApproval: ProjectExperienceActions['resolveApproval'];
  answerQuestion: (requestId: string, answer: string) => void;
  pauseAll: ProjectExperienceActions['pauseAll'];
  sendNativeCliInput: ProjectExperienceActions['sendNativeCliInput'];
  stopNativeCli: ProjectExperienceActions['stopNativeCli'];
}

interface ChatRoomCanvasSource {
  projectId: string;
  ready: boolean;
  participants: Participant[];
  railAgents: Participant[];
  projectMembers: ProjectMember[];
  source: {
    transcriptItems: UIItem[];
    liveItems: UIItem[];
    liveTools?: Extract<UIItem, { kind: 'tool' }>[];
    nativeCliSessions: NativeCliSessionView[];
    human: Participant;
    nativeCliAvatarSeeds: Map<string, string>;
    nativeCliTags: Map<string, string>;
    nativeCliDisplayNames: Map<string, string>;
    showDeveloperOnlyMessages: boolean;
  };
  contextUsage?: ContextUsagePayload;
  modelProfiles: ProfileView[];
  approvals: ApprovalView[];
  questions: QuestionView[];
  mentionTargets: ProjectMentionTarget[];
  loadOlder: () => void;
  sendDirective: ProjectExperienceActions['sendDirective'];
  resolveApproval: ProjectExperienceActions['resolveApproval'];
  answerQuestion: (requestId: string, answer: string) => void;
  pauseAll: ProjectExperienceActions['pauseAll'];
  sendNativeCliInput: ProjectExperienceActions['sendNativeCliInput'];
  stopNativeCli: ProjectExperienceActions['stopNativeCli'];
}

export function toChatRoomCanvas(
  c: ChatRoomCanvasSource,
  actions?: Pick<ChatRoomCanvas, 'followNativeCliSession' | 'openAgentCard'>
): ChatRoomCanvas {
  const source = c.source;
  const liveItems = source.liveItems;
  const liveTools = source.liveTools ?? toolItems(liveItems);
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
        source.human
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
    human: source.human,
    showDeveloperOnlyMessages: source.showDeveloperOnlyMessages
  });
  const activity = activityRowsFromTools(liveTools);
  const nativeCliTemplateAgentNames = new Map(
    (c.projectMembers ?? [])
      .filter((member) => member.type === 'native-cli')
      .map((member) => [projectMemberStableId(member), member.templateName ?? member.name])
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
          avatarUrl: source?.nativeCliAvatarSeeds.has(typingAgentName)
            ? entityAvatarUrl(source.nativeCliAvatarSeeds.get(typingAgentName) as string)
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
    railAgents: c.railAgents,
    activity,
    nativeCliStreams,
    tasks,
    typing,
    contextUsage: c.contextUsage,
    modelProfiles: c.modelProfiles,
    approvals: c.approvals,
    questions: c.questions,
    mentionTargets: c.mentionTargets,
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
