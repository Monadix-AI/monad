import type { NativeCliObservationEvent, NativeCliSessionView, UIItem, UIMessageItem, UIPart } from '@monad/protocol';
import type { ActivityRow, Message, MessageAttachment, NativeCliStreamView, Participant } from '../../types';

import {
  avatarCacheKey,
  channelDisplayText,
  entityAvatarUrl,
  entityAvatarWriteUrl,
  messageAttachmentRefSchema
} from '@monad/protocol';

import { nativeCliStreamItems } from '../../native-cli-observation';
import {
  nativeCliAgentFacingCommandPhase,
  nativeCliMemberActivityPhase,
  nativeCliMemberPresence,
  nativeCliSessionIsGenerating
} from '../../native-cli-presence';
import {
  avatarForAgent,
  defaultProjectMemberSettings,
  fmtTime,
  HUMAN,
  iconForAgent,
  nativeCliProductDisplayName,
  nativeCliTag,
  parseProjectMembers,
  productIcon,
  renameNativeCliProjectMemberDisplayName
} from '../../project-projection';

const NATIVE_CLI_FOLLOW_TEXT = 'CLI stream available';

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

export function isManagedNativeCliReasoningOnlyMessage(item: UIMessageItem): boolean {
  return (
    item.source === 'managed-native-cli' &&
    item.role === 'assistant' &&
    !textFromParts(item.parts).trim() &&
    reasoningFromParts(item.parts) !== undefined
  );
}

export function messageToView(
  item: UIMessageItem,
  time = '',
  nativeCliAvatarSeeds = new Map<string, string>(),
  nativeCliTags = new Map<string, string>(),
  nativeCliDisplayNames = new Map<string, string>(),
  human = HUMAN
): Message {
  const agent = item.role === 'assistant';
  const rawName = agent ? (item.agentName ?? 'monad') : human.name;
  const displayName = agent ? (nativeCliDisplayNames.get(rawName) ?? rawName) : rawName;
  const reasoning = agent ? reasoningFromParts(item.parts) : undefined;
  const attachments = attachmentsFromParts(item.parts);
  const agentAvatarSeed =
    nativeCliAvatarSeeds.get(displayName) ??
    (displayName === 'monad'
      ? undefined
      : item.source === 'managed-native-cli'
        ? `native-cli:${displayName}`
        : `agent:${displayName}`);
  return {
    id: item.id,
    authorId: agent ? rawName : 'me',
    authorName: displayName,
    av: agent ? avatarForAgent(displayName) : human.av,
    icon: agent ? iconForAgent(displayName) : undefined,
    avatarUrl: agent ? (agentAvatarSeed ? entityAvatarUrl(agentAvatarSeed) : undefined) : human.avatarUrl,
    kind: agent ? 'agent' : human.kind,
    tag: agent ? (displayName === 'monad' ? 'AI' : (nativeCliTags.get(displayName) ?? 'ACP')) : human.tag,
    time,
    text: displayTextFromMessage(item),
    orderKey: item.seq,
    ...(reasoning ? { reasoning } : {}),
    ...(attachments.length ? { attachments } : {}),
    streaming: item.status === 'streaming'
  };
}

function nativeCliSessionMessage(session: NativeCliSessionView): Message {
  return nativeCliSessionMessageView(session, session.agentName);
}

function nativeCliAvatarUrl(displayName: string, nativeCliAvatarSeeds = new Map<string, string>()): string {
  return entityAvatarUrl(nativeCliAvatarSeeds.get(displayName) ?? `native-cli:${displayName}`);
}

function nativeCliSessionMessageView(
  session: NativeCliSessionView,
  displayName: string,
  nativeCliAvatarSeeds = new Map<string, string>()
): Message {
  const avatarUrl = nativeCliAvatarUrl(displayName, nativeCliAvatarSeeds);
  const text = session.state === 'failed' ? 'failed to join the project' : 'joined the project';
  return {
    id: `native-cli-session:${session.id}`,
    authorId: session.agentName,
    authorName: displayName,
    av: avatarForAgent(displayName),
    icon: productIcon(session.productIcon),
    avatarUrl,
    kind: 'system',
    tag: nativeCliTag(session.provider),
    time: fmtTime(session.startedAt),
    text,
    agentChip: {
      id: session.agentName,
      name: displayName,
      icon: productIcon(session.productIcon),
      avatarUrl,
      tag: nativeCliTag(session.provider)
    },
    nativeCliSessionId: session.id,
    streaming: false,
    orderKey: session.startedAt
  };
}

function nativeCliSessionDeveloperMessage(session: NativeCliSessionView): Message {
  return nativeCliSessionDeveloperMessageView(session, session.agentName);
}

function nativeCliSessionDeveloperMessageView(
  session: NativeCliSessionView,
  displayName: string,
  nativeCliAvatarSeeds = new Map<string, string>()
): Message {
  return {
    id: `native-cli-session-developer:${session.id}`,
    authorId: session.agentName,
    authorName: displayName,
    av: avatarForAgent(displayName),
    icon: productIcon(session.productIcon),
    avatarUrl: nativeCliAvatarUrl(displayName, nativeCliAvatarSeeds),
    kind: 'developer',
    tag: 'DEV',
    time: fmtTime(session.startedAt),
    text: NATIVE_CLI_FOLLOW_TEXT,
    nativeCliSessionId: session.id,
    developerOnly: true,
    orderKey: `${session.startedAt}:developer`
  };
}

function nativeCliSessionErrorMessageView(
  session: NativeCliSessionView,
  displayName: string,
  item: NativeCliObservationEvent,
  nativeCliAvatarSeeds = new Map<string, string>()
): Message {
  const icon = productIcon(session.productIcon);
  const avatarUrl = nativeCliAvatarUrl(displayName, nativeCliAvatarSeeds);
  return {
    id: `native-cli-session-error:${session.id}:${item.id}`,
    authorId: session.agentName,
    authorName: displayName,
    av: avatarForAgent(displayName),
    icon,
    avatarUrl,
    kind: 'system',
    tag: nativeCliTag(session.provider),
    time: fmtTime(session.updatedAt || session.startedAt),
    text: 'encountered an error',
    agentChip: {
      id: session.agentName,
      name: displayName,
      icon,
      avatarUrl,
      tag: nativeCliTag(session.provider)
    },
    nativeCliSessionId: session.id,
    orderKey: `${session.updatedAt || session.startedAt}:error:${item.id}`,
    systemTone: 'error',
    systemDetail: item.text,
    systemRaw: item.raw
  };
}

function nativeCliSessionErrorMessages(
  session: NativeCliSessionView,
  displayName: string,
  nativeCliAvatarSeeds = new Map<string, string>()
): Message[] {
  return nativeCliStreamItems({
    id: session.id,
    provider: session.provider,
    output: session.outputSnapshot,
    observedAt: session.updatedAt || session.startedAt
  })
    .filter((item) => item.providerEventType === 'server_error')
    .map((item) => nativeCliSessionErrorMessageView(session, displayName, item, nativeCliAvatarSeeds));
}

function sortMessagesOldestFirst(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => {
    const order = (a.orderKey || a.id).localeCompare(b.orderKey || b.id);
    return order === 0 ? a.id.localeCompare(b.id) : order;
  });
}

function keepManagedNativeCliRepliesAfterJoin(messages: Map<string, Message>): void {
  const joinOrderByAgent = new Map<string, string>();
  for (const message of messages.values()) {
    if (message.kind !== 'system' || !message.nativeCliSessionId || !message.orderKey) continue;
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

function firstNativeCliSessionsByAgent(sessions: NativeCliSessionView[]): NativeCliSessionView[] {
  const first = new Map<string, NativeCliSessionView>();
  for (const session of [...sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    if (first.has(session.agentName)) continue;
    first.set(session.agentName, session);
  }
  return [...first.values()];
}

function nativeCliStreamFromSession(session: NativeCliSessionView): NativeCliStreamView {
  const items = nativeCliStreamItems({
    id: session.id,
    provider: session.provider,
    output: session.outputSnapshot,
    observedAt: session.updatedAt || session.startedAt
  });
  return {
    id: session.id,
    agentName: session.agentName,
    provider: session.provider,
    tag: nativeCliTag(session.provider),
    icon: productIcon(session.productIcon),
    status: session.state === 'failed' ? 'error' : 'ok',
    workingPath: session.workingPath,
    output: session.outputSnapshot,
    items
  };
}

function nativeCliStreamFromActivity(row: ActivityRow): NativeCliStreamView | undefined {
  if (!row.tool.startsWith('native-cli:')) return undefined;
  const provider = row.tool.slice('native-cli:'.length) || 'native-cli';
  const items = nativeCliStreamItems({ id: row.id, provider, output: row.output });
  return {
    id: row.id,
    agentName: row.agentName ?? row.detail ?? provider,
    provider,
    tag: nativeCliTag(provider),
    status: row.status,
    output: row.output ?? '',
    items
  };
}

export function buildNativeCliStreams(
  nativeCliSessions: NativeCliSessionView[],
  activity: ActivityRow[]
): NativeCliStreamView[] {
  const byId = new Map<string, NativeCliStreamView>();
  for (const session of nativeCliSessions) byId.set(session.id, nativeCliStreamFromSession(session));
  for (const row of activity) {
    const stream = nativeCliStreamFromActivity(row);
    if (!stream) continue;
    const existing = byId.get(stream.id);
    byId.set(stream.id, {
      ...existing,
      ...stream,
      agentName: existing?.agentName ?? stream.agentName,
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
  nativeCliSessions: NativeCliSessionView[];
  liveItems: UIItem[];
  liveTools: Extract<UIItem, { kind: 'tool' }>[];
  nativeCliAvatarSeeds?: Map<string, string>;
  nativeCliTags?: Map<string, string>;
  nativeCliDisplayNames?: Map<string, string>;
  human?: Participant;
  showDeveloperOnlyMessages?: boolean;
}

export function buildProjectMessages({
  persistedMessages,
  nativeCliSessions,
  liveItems,
  liveTools,
  nativeCliAvatarSeeds = new Map(),
  nativeCliTags = new Map(),
  nativeCliDisplayNames = new Map(),
  human = HUMAN,
  showDeveloperOnlyMessages = false
}: BuildProjectMessagesInput): Message[] {
  const shouldShowDeveloperOnlyMessages = process.env.NODE_ENV !== 'production' && showDeveloperOnlyMessages;
  const byId = new Map<string, Message>();
  const toView = (item: UIMessageItem) =>
    messageToView(item, '', nativeCliAvatarSeeds, nativeCliTags, nativeCliDisplayNames, human);
  for (const view of persistedMessages) byId.set(view.id, view);
  const firstNativeCliSessions = firstNativeCliSessionsByAgent(nativeCliSessions);
  const firstNativeCliAgentNames = new Set(firstNativeCliSessions.map((session) => session.agentName));
  for (const session of firstNativeCliSessions) {
    const displayName = nativeCliDisplayNames.get(session.agentName) ?? session.agentName;
    byId.set(
      `native-cli-session:${session.id}`,
      nativeCliSessionMessageView(session, displayName, nativeCliAvatarSeeds)
    );
    for (const message of nativeCliSessionErrorMessages(session, displayName, nativeCliAvatarSeeds)) {
      byId.set(message.id, message);
    }
    if (shouldShowDeveloperOnlyMessages) {
      byId.set(
        `native-cli-session-developer:${session.id}`,
        nativeCliSessionDeveloperMessageView(session, displayName, nativeCliAvatarSeeds)
      );
    }
  }
  for (const item of liveItems) {
    if (item.kind === 'system') {
      const nativeCliResumeAgent = item.id.startsWith('native-cli-resume-failed:')
        ? item.id.slice('native-cli-resume-failed:'.length).split(':')[0]
        : undefined;
      const authorName = nativeCliResumeAgent || 'monad';
      byId.set(item.id, {
        id: item.id,
        authorId: authorName,
        authorName,
        av: avatarForAgent(authorName),
        icon: iconForAgent(authorName),
        avatarUrl: nativeCliResumeAgent ? entityAvatarUrl(`native-cli-resume:${authorName}`) : undefined,
        kind: 'system',
        tag: nativeCliResumeAgent ? 'CLI' : 'SYS',
        time: '',
        text: item.text,
        orderKey: item.seq
      });
      continue;
    }
    if (item.kind !== 'message') continue;
    if (isManagedNativeCliReasoningOnlyMessage(item)) continue;
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
    if (item.status !== 'running' || !item.tool.startsWith('native-cli:')) continue;
    const input = item.input as { agent?: unknown; productIcon?: unknown; provider?: unknown } | undefined;
    if (typeof input?.agent !== 'string') continue;
    const displayName = nativeCliDisplayNames.get(input.agent) ?? input.agent;
    const icon = productIcon(input.productIcon);
    if (!firstNativeCliAgentNames.has(input.agent)) {
      const provider = typeof input.provider === 'string' ? input.provider : item.tool.slice('native-cli:'.length);
      byId.set(`native-cli-session:${item.id}`, {
        id: `native-cli-session:${item.id}`,
        authorId: input.agent,
        authorName: displayName,
        av: avatarForAgent(displayName),
        icon,
        avatarUrl: nativeCliAvatarUrl(displayName, nativeCliAvatarSeeds),
        kind: 'system',
        tag: nativeCliTag(provider),
        time: '',
        text: 'joined the project',
        agentChip: {
          id: input.agent,
          name: displayName,
          icon,
          avatarUrl: nativeCliAvatarUrl(displayName, nativeCliAvatarSeeds),
          tag: nativeCliTag(provider)
        },
        nativeCliSessionId: item.id,
        streaming: false,
        orderKey: item.seq
      });
    }
    if (shouldShowDeveloperOnlyMessages && item.output) {
      byId.set(`native-cli-session-developer:${item.id}`, {
        id: `native-cli-session-developer:${item.id}`,
        authorId: input.agent,
        authorName: displayName,
        av: avatarForAgent(displayName),
        icon,
        avatarUrl: nativeCliAvatarUrl(displayName, nativeCliAvatarSeeds),
        kind: 'developer',
        tag: 'DEV',
        time: '',
        text: NATIVE_CLI_FOLLOW_TEXT,
        nativeCliSessionId: item.id,
        developerOnly: true,
        orderKey: `${item.seq}:developer`
      });
    }
  }
  keepManagedNativeCliRepliesAfterJoin(byId);
  return sortMessagesOldestFirst([...byId.values()]);
}

export const __workplaceProjectMessageTest = {
  buildProjectMessages,
  buildNativeCliStreams,
  avatarCacheKey,
  defaultProjectMemberSettings,
  entityAvatarUrl,
  entityAvatarWriteUrl,
  nativeCliMemberPresence,
  nativeCliMemberActivityPhase,
  nativeCliAgentFacingCommandPhase,
  nativeCliProductDisplayName,
  nativeCliSessionIsGenerating,
  nativeCliSessionMessage,
  nativeCliSessionDeveloperMessage,
  parseProjectMembers,
  renameNativeCliProjectMemberDisplayName,
  sortMessagesOldestFirst
};
