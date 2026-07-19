import type {
  AvatarStyle,
  MeshAgentObservationEvent,
  MeshSessionView,
  UIItem,
  UIMessageItem,
  UIPart
} from '@monad/protocol';
import type { ProjectMember } from '../../experience/project-members.ts';
import type {
  ActivityRow,
  MeshAgentStreamView,
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
  meshAgentProductDisplayName,
  messageAttachmentSchema,
  renameMeshAgentProjectMemberDisplayName
} from '@monad/protocol';

import {
  meshAgentNeutralStreamItems,
  meshAgentStreamItems
} from '../../experience/mesh-agent-observation/mesh-agent-observation.ts';
import {
  meshAgentFacingCommandPhase,
  meshAgentMemberActivityPhase,
  meshAgentMemberPresence,
  meshSessionIsGenerating
} from '../../experience/mesh-agent-presence.ts';
import { parseProjectMembers, productIcon } from '../../experience/project-members.ts';
import { avatarForAgent, fmtTime, HUMAN, iconForAgent, meshAgentTag } from '../../experience/project-projection.ts';

const MESH_AGENT_FOLLOW_TEXT = 'CLI stream available';

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
    const parsed = messageAttachmentSchema.safeParse(part.data);
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

export function isManagedMeshAgentReasoningOnlyMessage(item: UIMessageItem): boolean {
  return (
    item.source === 'managed-mesh-agent' &&
    item.role === 'assistant' &&
    !textFromParts(item.parts).trim() &&
    reasoningFromParts(item.parts) !== undefined
  );
}

export function messageToView(
  item: UIMessageItem,
  time = '',
  meshAgentAvatarSeeds = new Map<string, string>(),
  meshAgentTags = new Map<string, string>(),
  meshAgentDisplayNames = new Map<string, string>(),
  meshAgentIcons = new Map<string, Message['icon']>(),
  human = HUMAN,
  avatarStyle?: AvatarStyle
): Message {
  const agent = item.role === 'assistant';
  const rawName = agent ? (item.agentName ?? 'monad') : human.name;
  const displayName = agent
    ? (item.agentDisplayName ?? (rawName === 'monad' ? 'Monad' : (meshAgentDisplayNames.get(rawName) ?? rawName)))
    : rawName;
  const icon = agent ? (meshAgentIcons.get(rawName) ?? iconForAgent(displayName)) : undefined;
  const reasoning = agent ? reasoningFromParts(item.parts) : undefined;
  const attachments = attachmentsFromParts(item.parts);
  const agentAvatarSeed =
    meshAgentAvatarSeeds.get(displayName) ??
    (displayName === 'Monad'
      ? undefined
      : item.source === 'managed-mesh-agent'
        ? `mesh-agent:${displayName}`
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
        : (meshAgentTags.get(rawName) ?? meshAgentTags.get(displayName) ?? 'ACP')
      : human.tag,
    time,
    text: displayTextFromMessage(item),
    orderKey: item.seq,
    ...(item.meshSessionId ? { meshSessionId: item.meshSessionId } : {}),
    ...(item.deliveryId ? { deliveryId: item.deliveryId } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(attachments.length ? { attachments } : {}),
    streaming: item.status === 'streaming'
  };
}

function meshAgentAvatarUrl(
  displayName: string,
  meshAgentAvatarSeeds = new Map<string, string>(),
  avatarStyle?: AvatarStyle
): string {
  return entityAvatarUrl(meshAgentAvatarSeeds.get(displayName) ?? `mesh-agent:${displayName}`, avatarStyle);
}

function meshAgentSystemActorView({
  actorId,
  actorName,
  projectMembers,
  meshAgentDisplayNames,
  meshAgentAvatarSeeds,
  meshAgentIcons,
  meshAgentTags,
  avatarStyle
}: {
  actorId: string;
  actorName?: string;
  projectMembers: readonly ProjectMember[];
  meshAgentDisplayNames: Map<string, string>;
  meshAgentAvatarSeeds: Map<string, string>;
  meshAgentIcons: Map<string, Message['icon']>;
  meshAgentTags: Map<string, string>;
  avatarStyle?: AvatarStyle;
}): Pick<Message, 'authorId' | 'authorName' | 'av' | 'icon' | 'avatarUrl' | 'tag' | 'agentChip'> {
  const member = projectMembers.find((candidate) => candidate.type === 'mesh-agent' && candidate.id === actorId);
  const displayName = meshAgentDisplayNames.get(actorId) ?? member?.displayName ?? actorName ?? actorId;
  const avatarUrl = meshAgentAvatarUrl(displayName, meshAgentAvatarSeeds, avatarStyle);
  const icon =
    meshAgentIcons.get(actorId) ?? (member ? meshAgentIcons.get(member.name) : undefined) ?? iconForAgent(displayName);
  const tag = meshAgentTags.get(actorId) ?? (member ? meshAgentTags.get(member.name) : undefined) ?? 'CLI';
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
  meshAgentTags = new Map<string, string>(),
  meshAgentIcons = new Map<string, Message['icon']>(),
  meshAgentAvatarSeeds = new Map<string, string>(),
  avatarStyle?: AvatarStyle
): Message {
  const actor = meshAgentSystemActorView({
    actorId: member.id,
    actorName: displayName,
    projectMembers: [member],
    meshAgentDisplayNames: new Map([[member.id, displayName]]),
    meshAgentAvatarSeeds,
    meshAgentIcons,
    meshAgentTags,
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

function meshSessionDeveloperMessage(session: MeshSessionView): Message {
  return meshSessionDeveloperMessageView(session, session.agentName);
}

function meshSessionDeveloperMessageView(
  session: MeshSessionView,
  displayName: string,
  meshAgentAvatarSeeds = new Map<string, string>(),
  avatarStyle?: AvatarStyle
): Message {
  return {
    id: `mesh-session-developer:${session.id}`,
    authorId: session.agentName,
    authorName: displayName,
    av: avatarForAgent(displayName),
    icon: productIcon(session.productIcon),
    avatarUrl: meshAgentAvatarUrl(displayName, meshAgentAvatarSeeds, avatarStyle),
    kind: 'developer',
    tag: 'DEV',
    time: fmtTime(session.startedAt),
    text: MESH_AGENT_FOLLOW_TEXT,
    meshSessionId: session.id,
    developerOnly: true,
    orderKey: `${session.startedAt}:developer`
  };
}

function meshSessionErrorMessageView(
  session: MeshSessionView,
  displayName: string,
  item: MeshAgentObservationEvent,
  meshAgentAvatarSeeds = new Map<string, string>(),
  avatarStyle?: AvatarStyle
): Message {
  const icon = productIcon(session.productIcon);
  const avatarUrl = meshAgentAvatarUrl(displayName, meshAgentAvatarSeeds, avatarStyle);
  return {
    id: `mesh-session-error:${session.id}:${item.id}`,
    authorId: session.agentName,
    authorName: displayName,
    av: avatarForAgent(displayName),
    icon,
    avatarUrl,
    kind: 'system',
    tag: meshAgentTag(session.provider),
    time: fmtTime(session.updatedAt || session.startedAt),
    text: 'encountered an error',
    agentChip: {
      id: session.agentName,
      name: displayName,
      icon,
      avatarUrl,
      tag: meshAgentTag(session.provider)
    },
    meshSessionId: session.id,
    orderKey: `${session.updatedAt || session.startedAt}:error:${item.id}`,
    systemTone: 'error',
    systemDetail: item.text,
    systemRaw: item.provenance.rawEvents
  };
}

function meshSessionErrorMessages(
  session: MeshSessionView,
  displayName: string,
  meshAgentAvatarSeeds = new Map<string, string>(),
  avatarStyle?: AvatarStyle
): Message[] {
  return meshAgentStreamItems({
    id: session.id,
    provider: session.provider,
    output: session.outputSnapshot,
    observedAt: session.updatedAt || session.startedAt
  })
    .filter((item) => item.providerEventType === 'server_error')
    .map((item) => meshSessionErrorMessageView(session, displayName, item, meshAgentAvatarSeeds, avatarStyle));
}

export function sortMessagesOldestFirst(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => {
    const order = (a.orderKey || a.id).localeCompare(b.orderKey || b.id);
    return order === 0 ? a.id.localeCompare(b.id) : order;
  });
}

function keepManagedMeshAgentRepliesAfterJoin(messages: Map<string, Message>): void {
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

function currentMeshSessionsByAgent(sessions: MeshSessionView[]): MeshSessionView[] {
  const current = new Map<string, MeshSessionView>();
  for (const session of [...sessions].sort((a, b) => {
    const byUpdatedAt = (b.updatedAt || b.startedAt).localeCompare(a.updatedAt || a.startedAt);
    return byUpdatedAt === 0 ? b.id.localeCompare(a.id) : byUpdatedAt;
  })) {
    if (current.has(session.agentName)) continue;
    current.set(session.agentName, session);
  }
  return [...current.values()];
}

function meshAgentStreamFromSession(
  session: MeshSessionView,
  templateAgentNames = new Map<string, string>(),
  agentAliases = new Map<string, string[]>()
): MeshAgentStreamView {
  const items = meshAgentNeutralStreamItems({
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
    tag: meshAgentTag(session.provider),
    icon: productIcon(session.productIcon),
    status: session.state === 'failed' ? 'error' : 'ok',
    workingPath: session.workingPath,
    observedAt: session.updatedAt || session.startedAt,
    output: session.outputSnapshot,
    items
  };
}

function meshAgentStreamFromActivity(
  row: ActivityRow,
  templateAgentNames = new Map<string, string>(),
  agentAliases = new Map<string, string[]>()
): MeshAgentStreamView | undefined {
  if (!row.tool.startsWith('mesh-agent:')) return undefined;
  const provider = row.tool.slice('mesh-agent:'.length);
  const agentName = row.agentName ?? row.detail ?? provider;
  const items = meshAgentNeutralStreamItems({ id: row.id, provider, output: row.output });
  return {
    id: row.id,
    agentName,
    ...(agentAliases.get(agentName)?.length ? { agentAliases: agentAliases.get(agentName) } : {}),
    ...(templateAgentNames.get(agentName) ? { templateAgentName: templateAgentNames.get(agentName) } : {}),
    provider,
    tag: meshAgentTag(provider),
    status: row.status,
    output: row.output ?? '',
    items
  };
}

export function buildMeshAgentStreams(
  meshSessions: MeshSessionView[],
  activity: ActivityRow[],
  templateAgentNames = new Map<string, string>(),
  agentAliases = new Map<string, string[]>()
): MeshAgentStreamView[] {
  const byId = new Map<string, MeshAgentStreamView>();
  for (const session of meshSessions)
    byId.set(session.id, meshAgentStreamFromSession(session, templateAgentNames, agentAliases));
  for (const row of activity) {
    const stream = meshAgentStreamFromActivity(row, templateAgentNames, agentAliases);
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

function meshAgentSystemAgentName(id: string): string | undefined {
  for (const prefix of ['mesh-agent-resume-failed:', 'mesh-agent-idle-resumed:', 'mesh-agent-idle-suspended:']) {
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
  meshSessions: MeshSessionView[];
  liveItems: readonly UIItem[];
  liveTools: readonly Extract<UIItem, { kind: 'tool' }>[];
  meshAgentAvatarSeeds?: Map<string, string>;
  meshAgentTags?: Map<string, string>;
  meshAgentDisplayNames?: Map<string, string>;
  meshAgentIcons?: Map<string, Message['icon']>;
  human?: Participant;
  avatarStyle?: AvatarStyle;
  showDeveloperOnlyMessages?: boolean;
}

export function buildProjectMessages({
  persistedMessages,
  projectMembers = [],
  meshSessions,
  liveItems,
  liveTools,
  meshAgentAvatarSeeds = new Map(),
  meshAgentTags = new Map(),
  meshAgentDisplayNames = new Map(),
  meshAgentIcons = new Map(),
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
      meshAgentAvatarSeeds,
      meshAgentTags,
      meshAgentDisplayNames,
      meshAgentIcons,
      human,
      avatarStyle
    );
  for (const view of persistedMessages) byId.set(view.id, view);
  for (const member of projectMembers) {
    if (member.type !== 'mesh-agent' || !member.joinedAt) continue;
    const displayName = meshAgentDisplayNames.get(member.id) ?? member.displayName ?? member.name;
    byId.set(
      `project-member-joined:${member.id}`,
      projectMemberJoinMessageView(
        member as ProjectMember & { joinedAt: string },
        displayName,
        meshAgentTags,
        meshAgentIcons,
        meshAgentAvatarSeeds,
        avatarStyle
      )
    );
  }
  const currentMeshSessions = currentMeshSessionsByAgent(meshSessions);
  for (const session of currentMeshSessions) {
    const displayName = meshAgentDisplayNames.get(session.agentName) ?? session.agentName;
    for (const message of meshSessionErrorMessages(session, displayName, meshAgentAvatarSeeds, avatarStyle)) {
      byId.set(message.id, message);
    }
    if (shouldShowDeveloperOnlyMessages) {
      byId.set(
        `mesh-session-developer:${session.id}`,
        meshSessionDeveloperMessageView(session, displayName, meshAgentAvatarSeeds, avatarStyle)
      );
    }
  }
  for (const item of liveItems) {
    if (item.kind === 'system') {
      if (item.event) {
        byId.set(item.id, {
          id: item.id,
          ...meshAgentSystemActorView({
            actorId: item.event.agentId,
            actorName: item.event.agentName,
            projectMembers,
            meshAgentDisplayNames,
            meshAgentAvatarSeeds,
            meshAgentIcons,
            meshAgentTags,
            avatarStyle
          }),
          kind: 'system',
          time: '',
          text: item.text,
          orderKey: item.seq
        });
        continue;
      }
      const meshAgentLifecycleAgent = meshAgentSystemAgentName(item.id);
      const authorName = meshAgentLifecycleAgent || 'Monad';
      byId.set(item.id, {
        id: item.id,
        authorId: authorName,
        authorName,
        av: avatarForAgent(authorName),
        icon: iconForAgent(authorName),
        avatarUrl: meshAgentLifecycleAgent
          ? entityAvatarUrl(`mesh-agent-resume:${authorName}`, avatarStyle)
          : undefined,
        kind: 'system',
        tag: meshAgentLifecycleAgent ? 'CLI' : 'SYS',
        time: '',
        text: item.text,
        orderKey: item.seq
      });
      continue;
    }
    if (item.kind !== 'message') continue;
    if (isManagedMeshAgentReasoningOnlyMessage(item)) continue;
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
    if (item.status !== 'running' || !item.tool.startsWith('mesh-agent:')) continue;
    const input = item.input as { agent?: unknown; productIcon?: unknown; provider?: unknown } | undefined;
    if (typeof input?.agent !== 'string') continue;
    const displayName = meshAgentDisplayNames.get(input.agent) ?? input.agent;
    if (shouldShowDeveloperOnlyMessages && item.output) {
      byId.set(`mesh-session-developer:${item.id}`, {
        id: `mesh-session-developer:${item.id}`,
        authorId: input.agent,
        authorName: displayName,
        av: avatarForAgent(displayName),
        icon: productIcon(input.productIcon),
        avatarUrl: meshAgentAvatarUrl(displayName, meshAgentAvatarSeeds, avatarStyle),
        kind: 'developer',
        tag: 'DEV',
        time: '',
        text: MESH_AGENT_FOLLOW_TEXT,
        meshSessionId: item.id,
        developerOnly: true,
        orderKey: `${item.seq}:developer`
      });
    }
  }
  keepManagedMeshAgentRepliesAfterJoin(byId);
  return sortMessagesOldestFirst([...byId.values()]);
}

export const __workplaceProjectMessageTest = {
  buildProjectMessages,
  buildMeshAgentStreams,
  avatarCacheKey,
  defaultProjectMemberSettings: defaultWorkplaceProjectMemberSettings,
  entityAvatarUrl,
  entityAvatarWriteUrl,
  meshAgentMemberPresence,
  meshAgentMemberActivityPhase,
  meshAgentFacingCommandPhase,
  meshAgentProductDisplayName,
  meshSessionIsGenerating,
  projectMemberJoinMessageView,
  meshSessionDeveloperMessage,
  parseProjectMembers,
  renameMeshAgentProjectMemberDisplayName,
  sortMessagesOldestFirst
};
