import type {
  AvatarStyle,
  ExternalAgentObservationEvent,
  ExternalAgentSessionView,
  UIItem,
  UIMessageItem,
  UIPart
} from '@monad/protocol';
import type { ProjectMember } from '../../experience/project-members.ts';
import type {
  ActivityRow,
  ExternalAgentStreamView,
  Message,
  MessageAttachment,
  Participant
} from '../../experience/types.ts';

import {
  avatarCacheKey,
  channelDisplayText,
  defaultWorkplaceProjectMemberSettings,
  entityAvatarUrl,
  entityAvatarWriteUrl,
  externalAgentProductDisplayName,
  messageAttachmentRefSchema,
  renameExternalAgentProjectMemberDisplayName
} from '@monad/protocol';

import {
  externalAgentNeutralStreamItems,
  externalAgentStreamItems
} from '../../experience/external-agent-observation/external-agent-observation.ts';
import {
  externalAgentFacingCommandPhase,
  externalAgentMemberActivityPhase,
  externalAgentMemberPresence,
  externalAgentSessionIsGenerating
} from '../../experience/external-agent-presence.ts';
import { parseProjectMembers, productIcon } from '../../experience/project-members.ts';
import { avatarForAgent, externalAgentTag, fmtTime, HUMAN, iconForAgent } from '../../experience/project-projection.ts';

const EXTERNAL_AGENT_FOLLOW_TEXT = 'CLI stream available';

function textFromParts(parts: UIPart[]): string {
  return parts
    .filter((part): part is Extract<UIPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function attachmentsFromParts(parts: UIPart[]): MessageAttachment[] {
  const attachments: MessageAttachment[] = [];
  for (const part of parts) {
    if (part.type !== 'custom' || part.name !== 'attachment') continue;
    const parsed = messageAttachmentRefSchema.safeParse(part.data);
    if (parsed.success) attachments.push(parsed.data);
  }
  return attachments;
}

function reasoningFromParts(parts: UIPart[]): string | undefined {
  const text = parts
    .filter((part): part is Extract<UIPart, { type: 'reasoning' }> => part.type === 'reasoning')
    .map((part) => part.text)
    .join('');
  return text || undefined;
}

function displayTextFromMessage(item: UIMessageItem): string {
  const text = textFromParts(item.parts);
  return item.role === 'assistant' ? channelDisplayText(text) : text;
}

export function isManagedExternalAgentReasoningOnlyMessage(item: UIMessageItem): boolean {
  return (
    item.source === 'managed-external-agent' &&
    item.role === 'assistant' &&
    !textFromParts(item.parts).trim() &&
    reasoningFromParts(item.parts) !== undefined
  );
}

export function messageToView(
  item: UIMessageItem,
  time = '',
  externalAgentAvatarSeeds = new Map<string, string>(),
  externalAgentTags = new Map<string, string>(),
  externalAgentDisplayNames = new Map<string, string>(),
  externalAgentIcons = new Map<string, Message['icon']>(),
  human = HUMAN,
  avatarStyle?: AvatarStyle
): Message {
  const agent = item.role === 'assistant';
  const rawName = agent ? (item.agentName ?? 'monad') : human.name;
  const displayName = agent
    ? (item.agentDisplayName ?? (rawName === 'monad' ? 'Monad' : (externalAgentDisplayNames.get(rawName) ?? rawName)))
    : rawName;
  const icon = agent ? (externalAgentIcons.get(rawName) ?? iconForAgent(displayName)) : undefined;
  const reasoning = agent ? reasoningFromParts(item.parts) : undefined;
  const attachments = attachmentsFromParts(item.parts);
  const agentAvatarSeed =
    externalAgentAvatarSeeds.get(displayName) ??
    (displayName === 'Monad'
      ? undefined
      : item.source === 'managed-external-agent'
        ? `external-agent:${displayName}`
        : `agent:${displayName}`);
  return {
    id: item.id,
    authorId: agent ? rawName : 'me',
    authorName: displayName,
    av: agent ? avatarForAgent(displayName) : human.av,
    icon,
    avatarUrl: agent ? (agentAvatarSeed ? entityAvatarUrl(agentAvatarSeed, avatarStyle) : undefined) : human.avatarUrl,
    kind: agent ? 'agent' : human.kind,
    tag: agent
      ? displayName === 'Monad'
        ? 'AI'
        : (externalAgentTags.get(rawName) ?? externalAgentTags.get(displayName) ?? 'ACP')
      : human.tag,
    time,
    text: displayTextFromMessage(item),
    orderKey: item.seq,
    ...(item.externalAgentSessionId ? { externalAgentSessionId: item.externalAgentSessionId } : {}),
    ...(item.deliveryId ? { deliveryId: item.deliveryId } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(attachments.length ? { attachments } : {}),
    streaming: item.status === 'streaming'
  };
}

function externalAgentAvatarUrl(
  displayName: string,
  externalAgentAvatarSeeds = new Map<string, string>(),
  avatarStyle?: AvatarStyle
): string {
  return entityAvatarUrl(externalAgentAvatarSeeds.get(displayName) ?? `external-agent:${displayName}`, avatarStyle);
}

function externalAgentSystemActorView({
  actorId,
  actorName,
  projectMembers,
  externalAgentDisplayNames,
  externalAgentAvatarSeeds,
  externalAgentIcons,
  externalAgentTags,
  avatarStyle
}: {
  actorId: string;
  actorName?: string;
  projectMembers: readonly ProjectMember[];
  externalAgentDisplayNames: Map<string, string>;
  externalAgentAvatarSeeds: Map<string, string>;
  externalAgentIcons: Map<string, Message['icon']>;
  externalAgentTags: Map<string, string>;
  avatarStyle?: AvatarStyle;
}): Pick<Message, 'authorId' | 'authorName' | 'av' | 'icon' | 'avatarUrl' | 'tag' | 'agentChip'> {
  const member = projectMembers.find((candidate) => candidate.type === 'external-agent' && candidate.id === actorId);
  const displayName = externalAgentDisplayNames.get(actorId) ?? member?.displayName ?? actorName ?? actorId;
  const avatarUrl = externalAgentAvatarUrl(displayName, externalAgentAvatarSeeds, avatarStyle);
  const icon =
    externalAgentIcons.get(actorId) ??
    (member ? externalAgentIcons.get(member.name) : undefined) ??
    iconForAgent(displayName);
  const tag = externalAgentTags.get(actorId) ?? (member ? externalAgentTags.get(member.name) : undefined) ?? 'CLI';
  return {
    authorId: actorId,
    authorName: displayName,
    av: avatarForAgent(displayName),
    icon,
    avatarUrl,
    tag,
    agentChip: {
      id: actorId,
      name: displayName,
      icon,
      avatarUrl,
      tag
    }
  };
}

function projectMemberJoinMessageView(
  member: ProjectMember & { joinedAt: string },
  displayName: string,
  externalAgentTags = new Map<string, string>(),
  externalAgentIcons = new Map<string, Message['icon']>(),
  externalAgentAvatarSeeds = new Map<string, string>(),
  avatarStyle?: AvatarStyle
): Message {
  const actor = externalAgentSystemActorView({
    actorId: member.id,
    actorName: displayName,
    projectMembers: [member],
    externalAgentDisplayNames: new Map([[member.id, displayName]]),
    externalAgentAvatarSeeds,
    externalAgentIcons,
    externalAgentTags,
    avatarStyle
  });
  return {
    id: `project-member-joined:${member.id}`,
    ...actor,
    kind: 'system',
    time: fmtTime(member.joinedAt),
    text: 'joined the project',
    streaming: false,
    orderKey: member.joinedAt
  };
}

function externalAgentSessionDeveloperMessage(session: ExternalAgentSessionView): Message {
  return externalAgentSessionDeveloperMessageView(session, session.agentName);
}

function externalAgentSessionDeveloperMessageView(
  session: ExternalAgentSessionView,
  displayName: string,
  externalAgentAvatarSeeds = new Map<string, string>(),
  avatarStyle?: AvatarStyle
): Message {
  return {
    id: `external-agent-session-developer:${session.id}`,
    authorId: session.agentName,
    authorName: displayName,
    av: avatarForAgent(displayName),
    icon: productIcon(session.productIcon),
    avatarUrl: externalAgentAvatarUrl(displayName, externalAgentAvatarSeeds, avatarStyle),
    kind: 'developer',
    tag: 'DEV',
    time: fmtTime(session.startedAt),
    text: EXTERNAL_AGENT_FOLLOW_TEXT,
    externalAgentSessionId: session.id,
    developerOnly: true,
    orderKey: `${session.startedAt}:developer`
  };
}

function externalAgentSessionErrorMessageView(
  session: ExternalAgentSessionView,
  displayName: string,
  item: ExternalAgentObservationEvent,
  externalAgentAvatarSeeds = new Map<string, string>(),
  avatarStyle?: AvatarStyle
): Message {
  const icon = productIcon(session.productIcon);
  const avatarUrl = externalAgentAvatarUrl(displayName, externalAgentAvatarSeeds, avatarStyle);
  return {
    id: `external-agent-session-error:${session.id}:${item.id}`,
    authorId: session.agentName,
    authorName: displayName,
    av: avatarForAgent(displayName),
    icon,
    avatarUrl,
    kind: 'system',
    tag: externalAgentTag(session.provider),
    time: fmtTime(session.updatedAt || session.startedAt),
    text: 'encountered an error',
    agentChip: {
      id: session.agentName,
      name: displayName,
      icon,
      avatarUrl,
      tag: externalAgentTag(session.provider)
    },
    externalAgentSessionId: session.id,
    orderKey: `${session.updatedAt || session.startedAt}:error:${item.id}`,
    systemTone: 'error',
    systemDetail: item.text,
    systemRaw: item.raw
  };
}

function externalAgentSessionErrorMessages(
  session: ExternalAgentSessionView,
  displayName: string,
  externalAgentAvatarSeeds = new Map<string, string>(),
  avatarStyle?: AvatarStyle
): Message[] {
  return externalAgentStreamItems({
    id: session.id,
    provider: session.provider,
    output: session.outputSnapshot,
    observedAt: session.updatedAt || session.startedAt
  })
    .filter((item) => item.providerEventType === 'server_error')
    .map((item) =>
      externalAgentSessionErrorMessageView(session, displayName, item, externalAgentAvatarSeeds, avatarStyle)
    );
}

function sortMessagesOldestFirst(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => {
    const order = (a.orderKey || a.id).localeCompare(b.orderKey || b.id);
    return order === 0 ? a.id.localeCompare(b.id) : order;
  });
}

function keepManagedExternalAgentRepliesAfterJoin(messages: Map<string, Message>): void {
  const joinByAgent = new Map<string, string>();
  for (const message of messages.values()) {
    if (message.kind !== 'system' || !message.id.startsWith('project-member-joined:') || !message.orderKey) continue;
    const existing = joinByAgent.get(message.authorId);
    if (!existing || message.orderKey < existing) joinByAgent.set(message.authorId, message.orderKey);
  }
  for (const [id, message] of messages) {
    if (message.kind !== 'agent' || !message.orderKey) continue;
    const joinOrderKey = joinByAgent.get(message.authorId);
    if (!joinOrderKey || message.orderKey > joinOrderKey) continue;
    messages.set(id, { ...message, orderKey: `${joinOrderKey}:message:${message.orderKey}` });
  }
}

function currentExternalAgentSessionsByAgent(sessions: ExternalAgentSessionView[]): ExternalAgentSessionView[] {
  const current = new Map<string, ExternalAgentSessionView>();
  for (const session of [...sessions].sort((a, b) => {
    const byUpdatedAt = (b.updatedAt || b.startedAt).localeCompare(a.updatedAt || a.startedAt);
    return byUpdatedAt === 0 ? b.id.localeCompare(a.id) : byUpdatedAt;
  })) {
    if (current.has(session.agentName)) continue;
    current.set(session.agentName, session);
  }
  return [...current.values()];
}

function externalAgentStreamFromSession(
  session: ExternalAgentSessionView,
  templateAgentNames = new Map<string, string>(),
  agentAliases = new Map<string, string[]>()
): ExternalAgentStreamView {
  const items = externalAgentNeutralStreamItems({
    id: session.id,
    provider: session.provider,
    output: session.outputSnapshot,
    observedAt: session.updatedAt || session.startedAt
  });
  return {
    id: session.id,
    transcriptTargetId: session.sessionId,
    agentName: session.agentName,
    ...(agentAliases.get(session.agentName)?.length ? { agentAliases: agentAliases.get(session.agentName) } : {}),
    ...(templateAgentNames.get(session.agentName)
      ? { templateAgentName: templateAgentNames.get(session.agentName) }
      : {}),
    provider: session.provider,
    tag: externalAgentTag(session.provider),
    icon: productIcon(session.productIcon),
    status: session.state === 'failed' ? 'error' : 'ok',
    workingPath: session.workingPath,
    observedAt: session.updatedAt || session.startedAt,
    output: session.outputSnapshot,
    items
  };
}

function externalAgentStreamFromActivity(
  row: ActivityRow,
  templateAgentNames = new Map<string, string>(),
  agentAliases = new Map<string, string[]>()
): ExternalAgentStreamView | undefined {
  if (!row.tool.startsWith('external-agent:')) return undefined;
  const provider = row.tool.slice('external-agent:'.length);
  const agentName = row.agentName ?? row.detail ?? provider;
  const items = externalAgentNeutralStreamItems({ id: row.id, provider, output: row.output });
  return {
    id: row.id,
    agentName,
    ...(agentAliases.get(agentName)?.length ? { agentAliases: agentAliases.get(agentName) } : {}),
    ...(templateAgentNames.get(agentName) ? { templateAgentName: templateAgentNames.get(agentName) } : {}),
    provider,
    tag: externalAgentTag(provider),
    status: row.status,
    output: row.output ?? '',
    items
  };
}

export function buildExternalAgentStreams(
  externalAgentSessions: ExternalAgentSessionView[],
  activity: ActivityRow[],
  templateAgentNames = new Map<string, string>(),
  agentAliases = new Map<string, string[]>()
): ExternalAgentStreamView[] {
  const byId = new Map<string, ExternalAgentStreamView>();
  for (const session of externalAgentSessions)
    byId.set(session.id, externalAgentStreamFromSession(session, templateAgentNames, agentAliases));
  for (const row of activity) {
    const stream = externalAgentStreamFromActivity(row, templateAgentNames, agentAliases);
    if (!stream) continue;
    const existing = byId.get(stream.id);
    byId.set(stream.id, {
      ...existing,
      ...stream,
      agentName: existing?.agentName ?? stream.agentName,
      templateAgentName: existing?.templateAgentName ?? stream.templateAgentName,
      workingPath: existing?.workingPath,
      output: stream.output || existing?.output || '',
      items: stream.items.length > 0 ? stream.items : (existing?.items ?? [])
    });
  }
  return [...byId.values()];
}

function acpAgentNameFromTool(item: Extract<UIItem, { kind: 'tool' }>): string | undefined {
  if (!item.tool.startsWith('acp:')) return undefined;
  const inputAgent = (item.input as { agent?: unknown } | undefined)?.agent;
  if (typeof inputAgent === 'string' && inputAgent) return inputAgent;
  const name = item.tool.slice(4);
  return name || undefined;
}

function externalAgentSystemAgentName(id: string): string | undefined {
  for (const prefix of [
    'external-agent-resume-failed:',
    'external-agent-idle-resumed:',
    'external-agent-idle-suspended:'
  ]) {
    if (id.startsWith(prefix)) return id.slice(prefix.length).split(':')[0];
  }
  return undefined;
}

export function acpProgressText(output: string | undefined): string {
  const text = output?.trim() ?? '';
  if (!text || text === 'waiting for response...') return '';
  const responseMarker = 'response stream:';
  const responseStart = text.lastIndexOf(responseMarker);
  if (responseStart >= 0) {
    const response = text.slice(responseStart + responseMarker.length).trim();
    if (response) return response;
  }
  return text;
}

interface BuildProjectMessagesInput {
  persistedMessages: Message[];
  projectMembers?: readonly ProjectMember[];
  externalAgentSessions: ExternalAgentSessionView[];
  liveItems: readonly UIItem[];
  liveTools: readonly Extract<UIItem, { kind: 'tool' }>[];
  externalAgentAvatarSeeds?: Map<string, string>;
  externalAgentTags?: Map<string, string>;
  externalAgentDisplayNames?: Map<string, string>;
  externalAgentIcons?: Map<string, Message['icon']>;
  human?: Participant;
  avatarStyle?: AvatarStyle;
  showDeveloperOnlyMessages?: boolean;
}

export function buildProjectMessages({
  persistedMessages,
  projectMembers = [],
  externalAgentSessions,
  liveItems,
  liveTools,
  externalAgentAvatarSeeds = new Map(),
  externalAgentTags = new Map(),
  externalAgentDisplayNames = new Map(),
  externalAgentIcons = new Map(),
  human = HUMAN,
  avatarStyle,
  showDeveloperOnlyMessages = false
}: BuildProjectMessagesInput): Message[] {
  const shouldShowDeveloperOnlyMessages = process.env.NODE_ENV !== 'production' && showDeveloperOnlyMessages;
  const byId = new Map<string, Message>();
  const toView = (item: UIMessageItem) =>
    messageToView(
      item,
      '',
      externalAgentAvatarSeeds,
      externalAgentTags,
      externalAgentDisplayNames,
      externalAgentIcons,
      human,
      avatarStyle
    );
  for (const view of persistedMessages) byId.set(view.id, view);
  for (const member of projectMembers) {
    if (member.type !== 'external-agent' || !member.joinedAt) continue;
    const displayName = externalAgentDisplayNames.get(member.id) ?? member.displayName ?? member.name;
    byId.set(
      `project-member-joined:${member.id}`,
      projectMemberJoinMessageView(
        member as ProjectMember & { joinedAt: string },
        displayName,
        externalAgentTags,
        externalAgentIcons,
        externalAgentAvatarSeeds,
        avatarStyle
      )
    );
  }
  const currentExternalAgentSessions = currentExternalAgentSessionsByAgent(externalAgentSessions);
  for (const session of currentExternalAgentSessions) {
    const displayName = externalAgentDisplayNames.get(session.agentName) ?? session.agentName;
    for (const message of externalAgentSessionErrorMessages(
      session,
      displayName,
      externalAgentAvatarSeeds,
      avatarStyle
    )) {
      byId.set(message.id, message);
    }
    if (shouldShowDeveloperOnlyMessages) {
      byId.set(
        `external-agent-session-developer:${session.id}`,
        externalAgentSessionDeveloperMessageView(session, displayName, externalAgentAvatarSeeds, avatarStyle)
      );
    }
  }
  for (const item of liveItems) {
    if (item.kind === 'system') {
      if (item.event) {
        byId.set(item.id, {
          id: item.id,
          ...externalAgentSystemActorView({
            actorId: item.event.agentId,
            actorName: item.event.agentName,
            projectMembers,
            externalAgentDisplayNames,
            externalAgentAvatarSeeds,
            externalAgentIcons,
            externalAgentTags,
            avatarStyle
          }),
          kind: 'system',
          time: '',
          text: item.text,
          orderKey: item.seq
        });
        continue;
      }
      const externalAgentLifecycleAgent = externalAgentSystemAgentName(item.id);
      const authorName = externalAgentLifecycleAgent || 'Monad';
      byId.set(item.id, {
        id: item.id,
        authorId: authorName,
        authorName,
        av: avatarForAgent(authorName),
        icon: iconForAgent(authorName),
        avatarUrl: externalAgentLifecycleAgent
          ? entityAvatarUrl(`external-agent-resume:${authorName}`, avatarStyle)
          : undefined,
        kind: 'system',
        tag: externalAgentLifecycleAgent ? 'CLI' : 'SYS',
        time: '',
        text: item.text,
        orderKey: item.seq
      });
      continue;
    }
    if (item.kind !== 'message') continue;
    if (isManagedExternalAgentReasoningOnlyMessage(item)) continue;
    const text = displayTextFromMessage(item);
    const reasoning = item.role === 'assistant' ? reasoningFromParts(item.parts) : undefined;
    if (text || reasoning || item.status !== 'streaming') byId.set(item.id, toView(item));
  }
  const streamingAgentNames = new Set(
    [...byId.values()]
      .filter((message) => message.kind === 'agent' && message.streaming)
      .map((message) => message.authorName)
  );
  for (const item of liveTools) {
    if (item.status !== 'running') continue;
    const agentName = acpAgentNameFromTool(item);
    if (!agentName || streamingAgentNames.has(agentName)) continue;
    const text = acpProgressText(item.output);
    if (!text) continue;
    byId.set(`acp-progress:${item.id}`, {
      id: `acp-progress:${item.id}`,
      authorId: agentName,
      authorName: agentName,
      av: avatarForAgent(agentName),
      icon: iconForAgent(agentName),
      kind: 'agent',
      tag: 'ACP',
      time: '',
      text,
      streaming: true,
      orderKey: item.seq
    });
  }
  for (const item of liveTools) {
    if (item.status !== 'running' || !item.tool.startsWith('external-agent:')) continue;
    const input = item.input as { agent?: unknown; productIcon?: unknown; provider?: unknown } | undefined;
    if (typeof input?.agent !== 'string') continue;
    const displayName = externalAgentDisplayNames.get(input.agent) ?? input.agent;
    if (shouldShowDeveloperOnlyMessages && item.output) {
      byId.set(`external-agent-session-developer:${item.id}`, {
        id: `external-agent-session-developer:${item.id}`,
        authorId: input.agent,
        authorName: displayName,
        av: avatarForAgent(displayName),
        icon: productIcon(input.productIcon),
        avatarUrl: externalAgentAvatarUrl(displayName, externalAgentAvatarSeeds, avatarStyle),
        kind: 'developer',
        tag: 'DEV',
        time: '',
        text: EXTERNAL_AGENT_FOLLOW_TEXT,
        externalAgentSessionId: item.id,
        developerOnly: true,
        orderKey: `${item.seq}:developer`
      });
    }
  }
  keepManagedExternalAgentRepliesAfterJoin(byId);
  return sortMessagesOldestFirst([...byId.values()]);
}

export const __workplaceProjectMessageTest = {
  buildProjectMessages,
  buildExternalAgentStreams,
  avatarCacheKey,
  defaultProjectMemberSettings: defaultWorkplaceProjectMemberSettings,
  entityAvatarUrl,
  entityAvatarWriteUrl,
  externalAgentMemberPresence,
  externalAgentMemberActivityPhase,
  externalAgentFacingCommandPhase,
  externalAgentProductDisplayName,
  externalAgentSessionIsGenerating,
  projectMemberJoinMessageView,
  externalAgentSessionDeveloperMessage,
  parseProjectMembers,
  renameExternalAgentProjectMemberDisplayName,
  sortMessagesOldestFirst
};
