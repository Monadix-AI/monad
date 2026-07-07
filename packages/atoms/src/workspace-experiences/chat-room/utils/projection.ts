import type {
  AvatarStyle,
  ExternalAgentObservationEvent,
  ExternalAgentSessionView,
  UIItem,
  UIMessageItem,
  UIPart
} from '@monad/protocol';
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
  const displayName = agent ? (externalAgentDisplayNames.get(rawName) ?? rawName) : rawName;
  const icon = agent ? (externalAgentIcons.get(rawName) ?? iconForAgent(displayName)) : undefined;
  const reasoning = agent ? reasoningFromParts(item.parts) : undefined;
  const attachments = attachmentsFromParts(item.parts);
  const agentAvatarSeed =
    externalAgentAvatarSeeds.get(displayName) ??
    (displayName === 'monad'
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
      ? displayName === 'monad'
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

function externalAgentSessionMessage(session: ExternalAgentSessionView): Message {
  return externalAgentSessionMessageView(session, session.agentName);
}

function externalAgentAvatarUrl(
  displayName: string,
  externalAgentAvatarSeeds = new Map<string, string>(),
  avatarStyle?: AvatarStyle
): string {
  return entityAvatarUrl(externalAgentAvatarSeeds.get(displayName) ?? `external-agent:${displayName}`, avatarStyle);
}

function externalAgentSessionMessageView(
  session: ExternalAgentSessionView,
  displayName: string,
  externalAgentAvatarSeeds = new Map<string, string>(),
  avatarStyle?: AvatarStyle
): Message {
  const avatarUrl = externalAgentAvatarUrl(displayName, externalAgentAvatarSeeds, avatarStyle);
  const text = session.state === 'failed' ? 'failed to join the project' : 'joined the project';
  return {
    id: `external-agent-session:${session.id}`,
    authorId: session.agentName,
    authorName: displayName,
    av: avatarForAgent(displayName),
    icon: productIcon(session.productIcon),
    avatarUrl,
    kind: 'system',
    tag: externalAgentTag(session.provider),
    time: fmtTime(session.startedAt),
    text,
    agentChip: {
      id: session.agentName,
      name: displayName,
      icon: productIcon(session.productIcon),
      avatarUrl,
      tag: externalAgentTag(session.provider)
    },
    externalAgentSessionId: session.id,
    streaming: false,
    orderKey: session.startedAt,
    ...(session.state === 'failed' ? { systemTone: 'error' as const } : {})
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
  const joinOrderByAgent = new Map<string, string>();
  for (const message of messages.values()) {
    if (message.kind !== 'system' || !message.externalAgentSessionId || !message.orderKey) continue;
    if (message.text !== 'joined the project' && message.text !== 'failed to join the project') continue;
    const existing = joinOrderByAgent.get(message.authorId);
    if (!existing || message.orderKey < existing) joinOrderByAgent.set(message.authorId, message.orderKey);
  }
  for (const [id, message] of messages) {
    if (message.kind !== 'agent' || !message.orderKey) continue;
    const joinOrder = joinOrderByAgent.get(message.authorId);
    if (!joinOrder || message.orderKey > joinOrder) continue;
    messages.set(id, { ...message, orderKey: `${joinOrder}:message:${message.orderKey}` });
  }
}

function collapseExternalAgentJoinPlaceholders(messages: Map<string, Message>): void {
  const repliesBySession = new Set<string>();
  const repliesByAgent = new Set<string>();
  for (const message of messages.values()) {
    if (message.kind !== 'agent') continue;
    if (message.externalAgentSessionId) repliesBySession.add(message.externalAgentSessionId);
    repliesByAgent.add(message.authorId);
  }
  for (const [id, message] of messages) {
    if (message.kind !== 'system' || message.text !== 'joined the project' || message.systemTone !== 'pending')
      continue;
    if (
      (message.externalAgentSessionId && repliesBySession.has(message.externalAgentSessionId)) ||
      repliesByAgent.has(message.authorId)
    ) {
      messages.delete(id);
    } else {
      messages.set(id, { ...message, systemTone: 'pending' });
    }
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
  const currentExternalAgentSessions = currentExternalAgentSessionsByAgent(externalAgentSessions);
  const currentExternalAgentNames = new Set(currentExternalAgentSessions.map((session) => session.agentName));
  const projectedExternalAgentNames = new Set(currentExternalAgentNames);
  for (const session of currentExternalAgentSessions) {
    const displayName = externalAgentDisplayNames.get(session.agentName) ?? session.agentName;
    byId.set(
      `external-agent-session:${session.id}`,
      externalAgentSessionMessageView(session, displayName, externalAgentAvatarSeeds, avatarStyle)
    );
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
      const externalAgentResumeAgent = item.id.startsWith('external-agent-resume-failed:')
        ? item.id.slice('external-agent-resume-failed:'.length).split(':')[0]
        : undefined;
      const authorName = externalAgentResumeAgent || 'monad';
      byId.set(item.id, {
        id: item.id,
        authorId: authorName,
        authorName,
        av: avatarForAgent(authorName),
        icon: iconForAgent(authorName),
        avatarUrl: externalAgentResumeAgent
          ? entityAvatarUrl(`external-agent-resume:${authorName}`, avatarStyle)
          : undefined,
        kind: 'system',
        tag: externalAgentResumeAgent ? 'CLI' : 'SYS',
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
    const icon = productIcon(input.productIcon);
    if (!projectedExternalAgentNames.has(input.agent)) {
      projectedExternalAgentNames.add(input.agent);
      const provider = typeof input.provider === 'string' ? input.provider : item.tool.slice('external-agent:'.length);
      byId.set(`external-agent-session:${item.id}`, {
        id: `external-agent-session:${item.id}`,
        authorId: input.agent,
        authorName: displayName,
        av: avatarForAgent(displayName),
        icon,
        avatarUrl: externalAgentAvatarUrl(displayName, externalAgentAvatarSeeds, avatarStyle),
        kind: 'system',
        tag: externalAgentTag(provider),
        time: '',
        text: 'joined the project',
        agentChip: {
          id: input.agent,
          name: displayName,
          icon,
          avatarUrl: externalAgentAvatarUrl(displayName, externalAgentAvatarSeeds, avatarStyle),
          tag: externalAgentTag(provider)
        },
        externalAgentSessionId: item.id,
        streaming: false,
        orderKey: item.seq,
        systemTone: 'pending'
      });
    }
    if (shouldShowDeveloperOnlyMessages && item.output) {
      byId.set(`external-agent-session-developer:${item.id}`, {
        id: `external-agent-session-developer:${item.id}`,
        authorId: input.agent,
        authorName: displayName,
        av: avatarForAgent(displayName),
        icon,
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
  collapseExternalAgentJoinPlaceholders(byId);
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
  externalAgentSessionMessage,
  externalAgentSessionDeveloperMessage,
  parseProjectMembers,
  renameExternalAgentProjectMemberDisplayName,
  sortMessagesOldestFirst
};
