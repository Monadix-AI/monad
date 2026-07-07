import type { ContextUsagePayload, NativeAgentDeliveryId, ProfileView, UIItem } from '@monad/protocol';
import type { ProjectExperienceCanvasSource } from '../../experience/source.ts';
import type {
  ActivityRow,
  AgentTask,
  ApprovalView,
  ExternalAgentStreamView,
  Message,
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
  buildExternalAgentStreams,
  buildProjectMessages,
  isManagedExternalAgentReasoningOnlyMessage,
  messageToView
} from './projection.ts';

export interface ChatRoomCanvas {
  draftKey: string;
  projectId: string;
  ready: boolean;
  human: Participant;
  messages: Message[];
  participants: Participant[];
  railAgents: Participant[];
  activity: ActivityRow[];
  busy: boolean;
  externalAgentStreams: ExternalAgentStreamView[];
  tasks: AgentTask[];
  typing: TypingIndicator | null;
  contextUsage?: ContextUsagePayload;
  modelProfiles: ProfileView[];
  approvals: ApprovalView[];
  questions: QuestionView[];
  mentionTargets: ProjectMentionTarget[];
  loadOlder: () => void;
  openAgentCard?: (id: string) => void;
  followExternalAgentSession?: (id: string, deliveryId?: NativeAgentDeliveryId) => void;
  sendDirective: import('./composer.ts').ProjectComposerSurface['sendDirective'];
  resolveApproval: (requestId: string, decision: 'approve' | 'reject') => void;
  answerQuestion: (requestId: string, answer: string) => void;
  pauseAll: () => void;
  sendExternalAgentInput: (id: string, input: string) => Promise<void>;
  stopExternalAgent: (id: string) => Promise<void>;
}

export type ChatRoomCanvasSource = ProjectExperienceCanvasSource;

export function toChatRoomCanvas(
  c: ChatRoomCanvasSource,
  actions?: Pick<ChatRoomCanvas, 'followExternalAgentSession' | 'openAgentCard'>
): ChatRoomCanvas {
  const source = c.source;
  const liveItems = source.liveItems;
  const liveTools = source.liveTools ?? toolItems(liveItems);
  const busy = projectCanvasIsBusy(liveItems, liveTools);
  const externalAgentIcons = new Map(source.externalAgentIcons ?? []);
  for (const session of source.externalAgentSessions)
    externalAgentIcons.set(session.agentName, productIcon(session.productIcon));
  const persistedMessages = source.transcriptItems
    .filter((item) => item.kind === 'message')
    .filter((item) => !isManagedExternalAgentReasoningOnlyMessage(item))
    .map((item) =>
      messageToView(
        item,
        fmtTime(item.seq),
        source.externalAgentAvatarSeeds,
        source.externalAgentTags,
        source.externalAgentDisplayNames,
        externalAgentIcons,
        source.human,
        source.avatarStyle
      )
    );
  const messages = buildProjectMessages({
    persistedMessages,
    externalAgentSessions: source.externalAgentSessions,
    liveItems,
    liveTools,
    externalAgentAvatarSeeds: source.externalAgentAvatarSeeds,
    externalAgentTags: source.externalAgentTags,
    externalAgentDisplayNames: source.externalAgentDisplayNames,
    externalAgentIcons,
    human: source.human,
    avatarStyle: source.avatarStyle,
    showDeveloperOnlyMessages: source.showDeveloperOnlyMessages
  });
  const activity = activityRowsFromTools(liveTools);
  const railAgents = projectMemberParticipants(c.participants);
  const externalAgentTemplateAgentNames = new Map(
    (c.projectMembers ?? [])
      .filter((member) => member.type === 'external-agent')
      .map((member) => [workplaceProjectMemberStableId(member), member.templateName ?? member.name])
  );
  const externalAgentAliases = new Map<string, string[]>();
  for (const member of c.projectMembers ?? []) {
    if (member.type !== 'external-agent') continue;
    const stableId = workplaceProjectMemberStableId(member);
    const aliases = [stableId, member.name, member.displayName, member.templateName].filter((value): value is string =>
      Boolean(value)
    );
    for (const alias of aliases) externalAgentAliases.set(alias, aliases);
  }
  const externalAgentStreams = buildExternalAgentStreams(
    source.externalAgentSessions,
    activity,
    externalAgentTemplateAgentNames,
    externalAgentAliases
  );
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
      item.source !== 'managed-external-agent'
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
          avatarUrl: source.externalAgentAvatarSeeds.has(typingAgentName)
            ? entityAvatarUrl(source.externalAgentAvatarSeeds.get(typingAgentName) as string, source.avatarStyle)
            : undefined,
          name: typingAgentName,
          detail: 'is working…'
        }
      : null;
  return {
    draftKey: `chat-room:${c.projectId}`,
    projectId: c.projectId,
    ready: c.ready,
    human: source.human,
    messages,
    participants: c.participants,
    railAgents,
    activity,
    busy,
    externalAgentStreams,
    tasks,
    typing,
    contextUsage: contextUsageFromItems(liveItems),
    modelProfiles: c.modelProfiles,
    approvals: projectApprovalViews(liveItems),
    questions: projectQuestionViews(liveItems),
    mentionTargets: railAgents.map((agent) => ({ id: agent.id, name: agent.name })),
    loadOlder: c.loadOlder,
    followExternalAgentSession: actions?.followExternalAgentSession,
    openAgentCard: actions?.openAgentCard,
    sendDirective: c.sendDirective,
    resolveApproval: c.resolveApproval,
    answerQuestion: c.answerQuestion,
    pauseAll: c.pauseAll,
    sendExternalAgentInput: c.sendExternalAgentInput,
    stopExternalAgent: c.stopExternalAgent
  };
}

export function projectCanvasIsBusy(
  liveItems: readonly UIItem[],
  liveTools: readonly Extract<UIItem, { kind: 'tool' }>[]
): boolean {
  return (
    liveItems.some((item) => {
      if (item.kind === 'message' || item.kind === 'custom') return item.status === 'streaming';
      if (item.kind === 'tool') return item.status === 'running';
      return item.kind === 'approval' || item.kind === 'clarification';
    }) || liveTools.some((tool) => tool.status === 'running')
  );
}
