import type {
  NativeCliProvider,
  NativeCliSessionView,
  UIItem,
  UIMessageItem,
  UIPart,
  WorkplaceProjectMember,
  WorkplaceProjectMemberSettings,
  WorkplaceProjectMemberType
} from '@monad/protocol';
import type { ActivityRow, AgentActivityPhase, Message, NativeCliStreamView, Participant, Presence } from './types';

import {
  avatarCacheKey,
  channelDisplayText,
  entityAvatarUrl,
  entityAvatarWriteUrl,
  workplaceProjectMembersExtSchema
} from '@monad/protocol';
import { isProductIconId } from '@monad/ui';

import { nativeCliStreamItems } from './native-cli-observation';

export type ProjectMemberType = WorkplaceProjectMemberType;
export type ProjectMemberSettings = WorkplaceProjectMemberSettings;
export type ProjectMember = WorkplaceProjectMember & { id: string };
export type AddProjectMemberOptions = {
  displayName?: string;
  modelId?: string;
  reasoningEffort?: string;
  speed?: 'standard' | 'fast';
  customPrompt?: string;
};

const NATIVE_CLI_FOLLOW_TEXT = 'CLI stream available';

export function projectMemberId(type: ProjectMemberType, name: string): string {
  if (type === 'monad') return 'monad';
  return `${type}:${name}`;
}

export function projectMemberStableId(member: WorkplaceProjectMember): string {
  return member.type === 'native-cli' && member.instanceId
    ? member.instanceId
    : projectMemberId(member.type, member.name);
}

export function parseProjectMembers(value: unknown): ProjectMember[] {
  const parsed = workplaceProjectMembersExtSchema.safeParse(value);
  if (!parsed.success) return [];
  return parsed.data.map((member) => ({ ...member, id: projectMemberStableId(member) }));
}

function safeNativeCliInstanceSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_') || 'cli';
}

export function safeNativeCliDisplayName(value: string): string {
  return value.replace(/[\\/:\0]/g, '_').trim() || 'CLI';
}

export function nativeCliProductDisplayName(
  icon: Participant['icon'] | undefined,
  provider: NativeCliProvider | string | undefined,
  fallback: string
): string {
  const product = icon ?? provider;
  if (product === 'codex') return 'OpenAI Codex';
  if (product === 'claude-code') return 'Claude Code';
  if (product === 'gemini') return 'Gemini CLI';
  if (product === 'qwen') return 'Qwen Code';
  return fallback;
}

export function uniqueNativeCliDisplayName(baseName: string, members: readonly ProjectMember[]): string {
  const used = new Set(members.map((member) => member.name));
  if (!used.has(baseName)) return baseName;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseName}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${baseName}-${Date.now().toString(36)}`;
}

export function newNativeCliInstanceId(templateName: string): string {
  const random =
    globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 12) ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `pmem_${safeNativeCliInstanceSegment(templateName)}_${random}`;
}

export function renameNativeCliProjectMemberDisplayName(member: ProjectMember, value?: string): ProjectMember {
  if (member.type !== 'native-cli') return member;
  const displayName = safeNativeCliDisplayName(value?.trim() || member.displayName || member.name);
  return { ...member, displayName };
}

export function nativeCliAvatarSeed(projectId: string, displayName: string): string {
  return ['native-cli', `project:${projectId}`, `name:${displayName}`].join('|');
}

export function nativeCliProjectMemberAvatarSeed(projectId: string, member: ProjectMember): string {
  return nativeCliAvatarSeed(projectId, member.displayName ?? member.name);
}

export function projectMemberAvatarSeeds(projectId: string, members: readonly ProjectMember[]): string[] {
  return members.flatMap((member) => {
    if (member.type === 'native-cli') return [nativeCliProjectMemberAvatarSeed(projectId, member)];
    if (member.type === 'acp') return [`acp:${member.name}`];
    return [];
  });
}

export function warmEntityAvatar(seed: string): void {
  void fetch(entityAvatarWriteUrl(seed)).catch(() => {});
}

export function defaultProjectMemberSettings(
  type: ProjectMemberType,
  agent:
    | {
        cwd?: string;
        osSandbox?: boolean;
        forwardMcp?: boolean;
      }
    | {
        defaultLaunchMode?: ProjectMemberSettings['launchMode'];
      }
    | undefined
): ProjectMemberSettings {
  if (type === 'monad') return {};
  if (type === 'acp') {
    return {
      ...(agent && 'cwd' in agent && agent.cwd ? { cwd: agent.cwd } : {}),
      ...(agent && 'osSandbox' in agent && agent.osSandbox !== undefined ? { osSandbox: agent.osSandbox } : {}),
      ...(agent && 'forwardMcp' in agent && agent.forwardMcp !== undefined ? { forwardMcp: agent.forwardMcp } : {})
    };
  }
  return {
    ...(agent && 'defaultLaunchMode' in agent && agent.defaultLaunchMode
      ? { launchMode: agent.defaultLaunchMode }
      : {}),
    managedProjectAgent: true
  };
}

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

function textFromParts(parts: UIPart[]): string {
  return parts
    .filter((part): part is Extract<UIPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
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
    streaming: item.status === 'streaming'
  };
}

export function projectMemberParticipants(participants: readonly Participant[]): Participant[] {
  return participants.filter((participant) => participant.kind === 'agent');
}

export function productIcon(value: unknown): Participant['icon'] | undefined {
  return typeof value === 'string' && isProductIconId(value) ? value : undefined;
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

function hasNativeCliLoginNeed(text: string | undefined): boolean {
  const normalized = text?.toLowerCase() ?? '';
  return (
    normalized.includes('connection_required') ||
    normalized.includes('login required') ||
    normalized.includes('not authenticated') ||
    normalized.includes('unauthenticated') ||
    normalized.includes('sign in')
  );
}

export function nativeCliAgentFacingCommandPhase(text: string | undefined): AgentActivityPhase | undefined {
  const normalized = text?.toLowerCase() ?? '';
  if (!normalized) return undefined;
  if (/\bmonad\s+project\s+(post|send)\b/.test(normalized)) return 'speaking';
  if (
    /\bmonad\s+project\s+read\b/.test(normalized) ||
    /\bmonad\s+project\s+inbox\s+(check|read)\b/.test(normalized) ||
    /\bmonad\s+inbox\s+(check|read)\b/.test(normalized)
  ) {
    return 'reading';
  }
  return undefined;
}

function newestNativeCliSession(sessions: NativeCliSessionView[]): NativeCliSessionView | undefined {
  return [...sessions].sort((a, b) => {
    const bTime = b.updatedAt || b.startedAt;
    const aTime = a.updatedAt || a.startedAt;
    return bTime.localeCompare(aTime);
  })[0];
}

function recordValue(record: unknown, key: string): unknown {
  return record && typeof record === 'object' && !Array.isArray(record)
    ? (record as Record<string, unknown>)[key]
    : undefined;
}

function codexStatusType(raw: unknown): string | undefined {
  const params = recordValue(raw, 'params');
  const status = recordValue(params, 'status');
  const value = recordValue(status, 'type') ?? recordValue(params, 'type');
  return typeof value === 'string' ? value : undefined;
}

// Callers evaluate this several times per member per recompute, and each evaluation
// would re-parse the session's full outputSnapshot (up to 256KB JSONL). Cache the flag
// per session id keyed on the snapshot so the parse runs once per snapshot change.
const nativeCliGeneratingCache = new Map<string, { snapshot: string | undefined; value: boolean }>();
const NATIVE_CLI_GENERATING_CACHE_LIMIT = 128;

export function nativeCliSessionIsGenerating(session: NativeCliSessionView): boolean {
  if (session.runtimeRole !== 'managed-project-agent' || session.state !== 'running') return false;
  const cached = nativeCliGeneratingCache.get(session.id);
  if (cached && cached.snapshot === session.outputSnapshot) return cached.value;
  const value = computeNativeCliSessionIsGenerating(session);
  if (!cached && nativeCliGeneratingCache.size >= NATIVE_CLI_GENERATING_CACHE_LIMIT) {
    const oldest = nativeCliGeneratingCache.keys().next().value;
    if (oldest !== undefined) nativeCliGeneratingCache.delete(oldest);
  }
  nativeCliGeneratingCache.set(session.id, { snapshot: session.outputSnapshot, value });
  return value;
}

function computeNativeCliSessionIsGenerating(session: NativeCliSessionView): boolean {
  let active = false;
  const items = nativeCliStreamItems({ id: session.id, provider: session.provider, output: session.outputSnapshot });
  for (const item of items) {
    const eventType = item.providerEventType;
    if (eventType === 'turn/started') {
      active = true;
      continue;
    }
    if (eventType === 'turn/completed' || eventType === 'result' || eventType === 'error') {
      active = false;
      continue;
    }
    if (eventType === 'thread/status/changed') {
      active = codexStatusType(item.raw) !== 'idle';
      continue;
    }
    if (
      eventType?.endsWith('/delta') === true ||
      eventType?.endsWith('Delta') === true ||
      eventType === 'item/started' ||
      eventType === 'function_call' ||
      eventType === 'content_block_start' ||
      eventType === 'content_block_delta' ||
      eventType === 'tool_use'
    ) {
      active = true;
    }
  }
  return active;
}

export function nativeCliMemberPresence({
  activeAgentNames,
  agentName,
  enabled,
  nativeCliSessions,
  liveTools
}: {
  activeAgentNames?: ReadonlySet<string>;
  agentName: string;
  enabled: boolean;
  nativeCliSessions: NativeCliSessionView[];
  liveTools: Extract<UIItem, { kind: 'tool' }>[];
}): Presence {
  const liveTool = liveTools.find((item) => {
    if (!item.tool.startsWith('native-cli:')) return false;
    const inputAgent = (item.input as { agent?: unknown } | undefined)?.agent;
    return inputAgent === agentName;
  });
  if (liveTool?.status === 'running') {
    if (hasNativeCliLoginNeed(liveTool.output)) return 'needs-login';
  }
  if (activeAgentNames?.has(agentName)) return 'working';
  const latest = newestNativeCliSession(nativeCliSessions.filter((session) => session.agentName === agentName));
  if (!latest) return enabled ? 'online' : 'idle';
  if ((latest.pendingApprovalCount ?? 0) > 0) return 'working';
  if (nativeCliSessionIsGenerating(latest)) return 'working';
  if (latest.state === 'running') return 'online';
  if (latest.state === 'starting') return 'working';
  if (hasNativeCliLoginNeed(latest.outputSnapshot)) return 'needs-login';
  if (latest.state === 'failed') return 'failed';
  if (latest.state === 'stopped' || latest.state === 'exited') return enabled ? 'online' : 'stopped';
  return enabled ? 'online' : 'idle';
}

export function nativeCliMemberActivityPhase({
  agentName,
  liveTools,
  nativeCliSessions
}: {
  agentName: string;
  liveTools: Extract<UIItem, { kind: 'tool' }>[];
  nativeCliSessions: NativeCliSessionView[];
}): AgentActivityPhase | undefined {
  const runningTool = liveTools.some((item) => {
    if (!item.tool.startsWith('native-cli:')) return false;
    const inputAgent = (item.input as { agent?: unknown } | undefined)?.agent;
    return item.status === 'running' && inputAgent === agentName;
  });
  if (runningTool) return 'thinking';
  const latest = newestNativeCliSession(nativeCliSessions.filter((session) => session.agentName === agentName));
  if (!latest) return undefined;
  if ((latest.pendingApprovalCount ?? 0) > 0 || latest.state === 'starting') return 'thinking';
  if (nativeCliSessionIsGenerating(latest)) return 'thinking';
  return undefined;
}

export function sortMessagesOldestFirst(messages: Message[]): Message[] {
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
  const items = nativeCliStreamItems({ id: session.id, provider: session.provider, output: session.outputSnapshot });
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

export function toolItems(items: UIItem[]): Extract<UIItem, { kind: 'tool' }>[] {
  return items.filter((item): item is Extract<UIItem, { kind: 'tool' }> => item.kind === 'tool');
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

export function summarizeTool(tool: string, input: unknown): string {
  const a = input as { agent?: string; instruction?: string; path?: string } | undefined;
  if (tool === 'agent_acp_delegate' && a?.agent) return `delegate to ${a.agent}`;
  if (tool.startsWith('acp:') && a?.agent) return `${a.agent} activity`;
  if (tool === 'agent_delegate') return 'delegate to a sub-agent';
  if (a?.path) return `${tool} · ${a.path}`;
  return tool;
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
