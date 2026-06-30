'use client';

// Single chokepoint between the workplace UI and the REAL monad backend.
//
// A project = a monad session (titled "Workplace: <slug>" in storage). Everything below is live:
//   - messages   ← useGetUiItemsInfiniteQuery (persisted) merged with the live
//                  useStreamUiItemsQuery feed (in-flight tokens / streaming).
//   - sendDirective → daemon-side routing. Bare no-host messages are recorded only.
//   - approvals  ← projected UI approval items (oversight gate) → useApproveToolMutation.
//   - activity   ← projected UI tool items (real tool calls).
//   - participants = you + monad + the invited ACP agents (configured via the real
//                     same-machine invite backend, useAcpAgentSettings).
//   - projects   = your multi-agent workplace sessions (useListSessionsQuery).

import type {
  Agent,
  AgentId,
  NativeCliLaunchMode,
  NativeCliProvider,
  NativeCliSessionView,
  Session,
  SessionId,
  UIItem,
  UIMessageItem,
  UIPart
} from '@monad/protocol';
import type {
  ActivityRow,
  AgentTask,
  ApprovalView,
  Message,
  NativeCliStreamView,
  Participant,
  Project,
  TypingIndicator
} from './types';

import {
  profileSelectors,
  sessionAdapter,
  sessionSelectors,
  useAbortSessionMutation,
  useApproveNativeCliSessionMutation,
  useApproveToolMutation,
  useCreateSessionMutation,
  useInputNativeCliSessionMutation,
  useListAgentsQuery,
  useListNativeCliSessionsQuery,
  useListProfilesQuery,
  useListSessionsQuery,
  useSendProjectMessageMutation,
  useStopNativeCliSessionMutation,
  useStreamUiItemsQuery,
  useUpdateSessionMutation
} from '@monad/client-rtk';
import { channelDisplayText } from '@monad/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAcpAgentSettings } from '@/hooks/use-acp-agent-settings';
import { useFirstItemIndex } from '@/hooks/use-first-item-index';
import { useNativeCliAgentSettings } from '@/hooks/use-native-cli-agent-settings';
import { useTranscriptHistory } from '@/hooks/use-transcript-history';
import { traceProjectDebugOperation } from '@/lib/project-debug-trace';
import { getWorkplaceProjectName, isWorkplaceProject, WORKPLACE_PROJECT_PREFIX } from '@/lib/workspace-sessions';
import { useWorkspaceShellStore } from '@/lib/workspace-shell-store';

export type ApprovalDecision = 'approve' | 'reject';
const EMPTY_PROFILES: { alias: string; provider: string; modelId: string }[] = [];
const EMPTY_AGENTS: Agent[] = [];
const EMPTY_ITEMS: UIItem[] = [];
const EMPTY_NATIVE_CLI_SESSIONS: NativeCliSessionView[] = [];
const SHOW_DEVELOPER_ONLY_MESSAGES = process.env.NODE_ENV !== 'production';

const messageId = (m: Message): string => m.id;
const CHANNEL_HOST_EXT_KEY = 'workplaceProjectModeratorAgentId';
const PROJECT_MEMBERS_EXT_KEY = 'workplaceProjectMembers';
type ProjectMemberType = 'acp' | 'native-cli';

interface ProjectMemberSettings {
  cwd?: string;
  osSandbox?: boolean;
  forwardMcp?: boolean;
  launchMode?: NativeCliLaunchMode;
}

interface ProjectMember {
  id: string;
  type: ProjectMemberType;
  name: string;
  settings?: ProjectMemberSettings;
}

function studioHostId(agentId: string): string {
  return `agent:${agentId}`;
}

function acpHostId(agentName: string): string {
  return `acp:${agentName}`;
}

function projectMemberId(type: ProjectMemberType, name: string): string {
  return `${type}:${name}`;
}

function normalizeModeratorAgentId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.startsWith('agt_') ? studioHostId(value) : value;
}

function parseProjectMembers(value: unknown): ProjectMember[] {
  if (!Array.isArray(value)) return [];
  const members: ProjectMember[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as { type?: unknown; name?: unknown; settings?: unknown };
    if (candidate.type !== 'acp' && candidate.type !== 'native-cli') continue;
    if (typeof candidate.name !== 'string' || !candidate.name.trim()) continue;
    const settings =
      candidate.settings && typeof candidate.settings === 'object'
        ? (candidate.settings as Record<string, unknown>)
        : undefined;
    members.push({
      id: projectMemberId(candidate.type, candidate.name),
      type: candidate.type,
      name: candidate.name,
      ...(settings
        ? {
            settings: {
              ...(typeof settings.cwd === 'string' ? { cwd: settings.cwd } : {}),
              ...(typeof settings.osSandbox === 'boolean' ? { osSandbox: settings.osSandbox } : {}),
              ...(typeof settings.forwardMcp === 'boolean' ? { forwardMcp: settings.forwardMcp } : {}),
              ...(settings.launchMode === 'pty' ||
              settings.launchMode === 'json-stream' ||
              settings.launchMode === 'app-server' ||
              settings.launchMode === 'remote-control'
                ? { launchMode: settings.launchMode }
                : {})
            }
          }
        : {})
    });
  }
  return members;
}

const HUMAN: Participant = {
  id: 'me',
  av: 'ME',
  name: 'Operator',
  kind: 'human',
  tag: 'User',
  role: 'supervisor',
  presence: 'online'
};

/** Up to two uppercase initials for an avatar. */
const initials = (name: string): string =>
  name
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .split(/[\s-]+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || name.slice(0, 2).toUpperCase();

const avatarForAgent = (name: string): string => (name === 'monad' ? 'MO' : initials(name));

const fmtTime = (iso?: string): string => {
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

function messageToView(item: UIMessageItem, time = ''): Message {
  const agent = item.role === 'assistant';
  const displayName = agent ? (item.agentName ?? 'monad') : HUMAN.name;
  const reasoning = agent ? reasoningFromParts(item.parts) : undefined;
  return {
    id: item.id,
    authorId: agent ? displayName : 'me',
    authorName: displayName,
    av: agent ? avatarForAgent(displayName) : HUMAN.av,
    icon: agent ? iconForAgent(displayName) : undefined,
    kind: agent ? 'agent' : 'human',
    tag: agent ? (displayName === 'monad' ? 'AI' : 'ACP') : HUMAN.tag,
    time,
    text: displayTextFromMessage(item),
    orderKey: item.seq,
    ...(reasoning ? { reasoning } : {}),
    streaming: item.status === 'streaming'
  };
}

function nativeCliIcon(provider: NativeCliProvider | string | undefined): Participant['icon'] | undefined {
  if (provider === 'codex') return 'openai';
  if (provider === 'claude-code') return 'anthropic';
  if (provider === 'gemini') return 'google';
  return undefined;
}

function nativeCliTag(provider: NativeCliProvider | string | undefined): string {
  if (provider === 'codex') return 'Codex';
  if (provider === 'claude-code') return 'Claude';
  if (provider === 'gemini') return 'Gemini';
  return 'CLI';
}

function nativeCliApprovalName(provider: NativeCliProvider | string | undefined): string {
  if (provider === 'codex') return 'Codex approval';
  if (provider === 'claude-code') return 'Claude Code approval';
  if (provider === 'gemini') return 'Gemini approval';
  return 'CLI approval';
}

function iconForAgent(name: string): Participant['icon'] | undefined {
  if (name === 'monad') return 'monad';
  if (name === 'codex') return 'openai';
  if (name === 'claude-code') return 'anthropic';
  if (name === 'gemini') return 'google';
  return undefined;
}

function nativeCliSessionMessage(session: NativeCliSessionView): Message {
  const text =
    session.state === 'failed'
      ? 'failed to join the project'
      : session.state === 'running'
        ? 'joined the project'
        : 'left the project';
  return {
    id: `native-cli-session:${session.id}`,
    authorId: session.agentName,
    authorName: session.agentName,
    av: avatarForAgent(session.agentName),
    icon: nativeCliIcon(session.provider),
    kind: 'system',
    tag: nativeCliTag(session.provider),
    time: fmtTime(session.startedAt),
    text,
    agentChip: {
      id: projectMemberId('native-cli', session.agentName),
      name: session.agentName,
      icon: nativeCliIcon(session.provider),
      tag: nativeCliTag(session.provider)
    },
    nativeCliSessionId: session.id,
    streaming: false,
    orderKey: session.startedAt
  };
}

function nativeCliSessionDeveloperMessage(session: NativeCliSessionView): Message {
  const exitText =
    session.state === 'running'
      ? ''
      : session.exitCode === null
        ? `\nstate: ${session.state}`
        : `\nstate: ${session.state} (${session.exitCode})`;
  return {
    id: `native-cli-session-developer:${session.id}`,
    authorId: session.agentName,
    authorName: session.agentName,
    av: avatarForAgent(session.agentName),
    icon: nativeCliIcon(session.provider),
    kind: 'developer',
    tag: 'DEV',
    time: fmtTime(session.startedAt),
    text: `started ${session.provider} in ${session.workingPath}${exitText}`,
    nativeCliSessionId: session.id,
    developerOnly: true,
    orderKey: `${session.startedAt}:developer`
  };
}

function sortMessagesOldestFirst(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => {
    const order = (a.orderKey || a.id).localeCompare(b.orderKey || b.id);
    return order === 0 ? a.id.localeCompare(b.id) : order;
  });
}

function nativeCliStreamFromSession(session: NativeCliSessionView): NativeCliStreamView {
  return {
    id: session.id,
    agentName: session.agentName,
    provider: session.provider,
    tag: nativeCliTag(session.provider),
    icon: nativeCliIcon(session.provider),
    status: session.state === 'failed' ? 'error' : session.state === 'running' ? 'running' : 'ok',
    workingPath: session.workingPath,
    output: session.outputSnapshot
  };
}

function nativeCliStreamFromActivity(row: ActivityRow): NativeCliStreamView | undefined {
  if (!row.tool.startsWith('native-cli:')) return undefined;
  const provider = row.tool.slice('native-cli:'.length) || 'native-cli';
  return {
    id: row.id,
    agentName: row.detail || provider,
    provider,
    tag: nativeCliTag(provider),
    icon: nativeCliIcon(provider),
    status: row.status,
    output: row.output ?? ''
  };
}

function buildNativeCliStreams(
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
      output: stream.output || existing?.output || ''
    });
  }
  return [...byId.values()];
}

export const __workplaceProjectMessageTest = {
  buildProjectMessages,
  buildNativeCliStreams,
  nativeCliSessionMessage,
  nativeCliSessionDeveloperMessage,
  sortMessagesOldestFirst
};

function toolItems(items: UIItem[]): Extract<UIItem, { kind: 'tool' }>[] {
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
  showDeveloperOnlyMessages?: boolean;
}

function buildProjectMessages({
  persistedMessages,
  nativeCliSessions,
  liveItems,
  liveTools,
  showDeveloperOnlyMessages = SHOW_DEVELOPER_ONLY_MESSAGES
}: BuildProjectMessagesInput): Message[] {
  const byId = new Map<string, Message>();
  const toView = messageToView;
  for (const view of persistedMessages) byId.set(view.id, view);
  for (const session of nativeCliSessions) {
    byId.set(`native-cli-session:${session.id}`, nativeCliSessionMessage(session));
    if (showDeveloperOnlyMessages) {
      byId.set(`native-cli-session-developer:${session.id}`, nativeCliSessionDeveloperMessage(session));
    }
  }
  for (const item of liveItems) {
    if (item.kind !== 'message') continue;
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
    const input = item.input as { agent?: unknown; provider?: unknown } | undefined;
    if (typeof input?.agent !== 'string') continue;
    const provider = typeof input.provider === 'string' ? input.provider : undefined;
    byId.set(`native-cli-session:${item.id}`, {
      id: `native-cli-session:${item.id}`,
      authorId: input.agent,
      authorName: input.agent,
      av: avatarForAgent(input.agent),
      icon: nativeCliIcon(provider),
      kind: 'system',
      tag: nativeCliTag(provider),
      time: '',
      text: 'joined the project',
      agentChip: {
        id: projectMemberId('native-cli', input.agent),
        name: input.agent,
        icon: nativeCliIcon(provider),
        tag: nativeCliTag(provider)
      },
      nativeCliSessionId: item.id,
      streaming: false,
      orderKey: item.seq
    });
    if (showDeveloperOnlyMessages && item.output) {
      byId.set(`native-cli-session-developer:${item.id}`, {
        id: `native-cli-session-developer:${item.id}`,
        authorId: input.agent,
        authorName: input.agent,
        av: avatarForAgent(input.agent),
        icon: nativeCliIcon(provider),
        kind: 'developer',
        tag: 'DEV',
        time: '',
        text: item.output,
        nativeCliSessionId: item.id,
        developerOnly: true,
        orderKey: `${item.seq}:developer`
      });
    }
  }
  return sortMessagesOldestFirst([...byId.values()]);
}

/** Short human summary of a tool call (delegations call out the target agent). */
function summarizeTool(tool: string, input: unknown): string {
  const a = input as { agent?: string; instruction?: string; path?: string } | undefined;
  if (tool === 'agent_acp_delegate' && a?.agent) return `delegate to ${a.agent}`;
  if (tool.startsWith('acp:') && a?.agent) return `${a.agent} activity`;
  if (tool === 'agent_delegate') return 'delegate to a sub-agent';
  if (a?.path) return `${tool} · ${a.path}`;
  return tool;
}

export function useProject(projectId: string) {
  const [sessionId, setSessionId] = useState<SessionId | null>(null);

  // --- sessions (projects) ---
  const { data: sessionData } = useListSessionsQuery(undefined);
  const { data: profileData } = useListProfilesQuery(undefined);
  const { data: agentsData } = useListAgentsQuery();
  const sessions: Session[] = useMemo(
    () => sessionSelectors.selectAll(sessionData?.sessions ?? sessionAdapter.getInitialState()),
    [sessionData]
  );
  const modelProfiles = useMemo(
    () => (profileData ? profileSelectors.selectAll(profileData.profiles) : EMPTY_PROFILES),
    [profileData]
  );
  const agents = agentsData?.agents ?? EMPTY_AGENTS;
  const [createSession] = useCreateSessionMutation();
  const creatingRef = useRef(false);

  useEffect(() => {
    setSessionId(null);
    creatingRef.current = false;
  }, []);

  // Resolve projectId → a session. Primary: match by session.id (real ID in URL).
  // Fallback: match by title for backward compat with old slug-based URLs.
  useEffect(() => {
    if (sessionId) return;
    const existing =
      sessions.find((s) => s.id === projectId) ??
      sessions.find((s) => s.title === WORKPLACE_PROJECT_PREFIX + projectId);
    if (existing) {
      setSessionId(existing.id);
      return;
    }
    if (!sessionData) return;
    // Only reach here for old slug URLs where no matching session exists yet — create one.
    if (creatingRef.current) return;
    creatingRef.current = true;
    const cwd = useWorkspaceShellStore.getState().takeProjectCwd(projectId);
    createSession({
      title: WORKPLACE_PROJECT_PREFIX + projectId,
      origin: { surface: 'web', client: 'workplace' },
      ...(cwd ? { cwd } : {})
    })
      .unwrap()
      .then((id) => setSessionId(id))
      .catch(() => {
        creatingRef.current = false;
      });
  }, [projectId, sessions, sessionData, sessionId, createSession]);

  // --- live stream + lazy older history ---
  const stream = useStreamUiItemsQuery((sessionId ?? '') as SessionId, { skip: sessionId === null });
  const nativeCliSessionsQ = useListNativeCliSessionsQuery((sessionId ?? '') as SessionId, {
    skip: sessionId === null
  });
  const transcript = useTranscriptHistory({
    sessionId,
    streamOldestCursor: stream.data?.oldestCursor,
    streamHasMore: stream.data?.hasMore ?? false
  });

  // --- invite backend (real) ---
  const acp = useAcpAgentSettings();
  const nativeCli = useNativeCliAgentSettings();
  const currentSession = useMemo(
    () => (sessionId ? (sessions.find((session) => session.id === sessionId) ?? null) : null),
    [sessions, sessionId]
  );
  const projectMembers = useMemo(
    () => parseProjectMembers(currentSession?.origin?.ext?.[PROJECT_MEMBERS_EXT_KEY]),
    [currentSession?.origin?.ext]
  );

  // --- participants ---
  const liveItems = stream.data?.items ?? EMPTY_ITEMS;
  const nativeCliSessions = nativeCliSessionsQ.data ?? EMPTY_NATIVE_CLI_SESSIONS;
  const contextUsage = liveItems.find(
    (item): item is Extract<UIItem, { kind: 'context' }> => item.kind === 'context'
  )?.usage;
  const liveTools = useMemo(() => toolItems(liveItems), [liveItems]);
  const streaming = liveItems.some(
    (item) =>
      (item.kind === 'message' && item.status === 'streaming') || (item.kind === 'tool' && item.status === 'running')
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
  const runningNativeCli = useMemo(() => {
    const names = new Set<string>();
    for (const s of liveTools) {
      if (s.status !== 'running' || !s.tool.startsWith('native-cli:')) continue;
      const agent = (s.input as Record<string, unknown> | undefined)?.agent;
      if (typeof agent === 'string') names.add(agent);
    }
    return names;
  }, [liveTools]);

  const participants: Participant[] = useMemo(() => {
    const monad: Participant = {
      id: 'monad',
      av: 'MO',
      icon: 'monad',
      name: 'monad',
      kind: 'agent',
      tag: 'AI',
      role: 'host',
      presence: streaming ? 'working' : 'online'
    };
    const members: Participant[] = projectMembers.map((member) => {
      if (member.type === 'native-cli') {
        const agent = nativeCli.agents.find((candidate) => candidate.name === member.name);
        const provider = agent?.provider;
        return {
          id: member.id,
          av: initials(member.name),
          icon: nativeCliIcon(provider),
          name: member.name,
          kind: 'agent',
          tag: nativeCliTag(provider),
          role: 'CLI',
          presence: runningNativeCli.has(member.name) ? 'working' : agent?.enabled ? 'online' : 'idle'
        };
      }
      const agent = acp.agents.find((candidate) => candidate.name === member.name);
      return {
        id: member.id,
        av: initials(member.name),
        icon: iconForAgent(member.name),
        name: member.name,
        kind: 'agent',
        tag: 'ACP',
        role: 'delegate',
        presence: runningDelegations.has(member.name) ? 'working' : agent?.enabled ? 'online' : 'idle'
      };
    });
    return [monad, ...members];
  }, [acp.agents, nativeCli.agents, projectMembers, streaming, runningDelegations, runningNativeCli]);
  const railAgents = useMemo(() => participants.filter((p) => p.kind === 'agent'), [participants]);

  // --- messages (history ⊕ live) ---
  // Persisted history only changes when a page loads, NOT per streamed token. Build its view objects
  // in a memo keyed on history.data so their references stay stable across token updates — that lets
  // React.memo(MessageRow) skip re-rendering every settled message (and re-parsing its markdown) on
  // each token; only the in-flight live message below gets a fresh object.
  const persistedMessages: Message[] = useMemo(() => {
    const out: Message[] = [];
    for (const item of transcript.items) {
      if (item.kind !== 'message') continue;
      out.push(messageToView(item, fmtTime(item.seq)));
    }
    return out;
  }, [transcript.items]);

  const messages: Message[] = useMemo(() => {
    return buildProjectMessages({ persistedMessages, nativeCliSessions, liveItems, liveTools });
  }, [persistedMessages, liveItems, liveTools, nativeCliSessions]);

  const firstItemIndex = useFirstItemIndex(messages, messageId);
  const loadOlder = transcript.loadOlder;

  const typingAgentName = [...runningDelegations][0] ?? [...runningNativeCli][0] ?? 'monad';
  const hasStreamingMessage = messages.some((message) => message.streaming && (message.text || message.reasoning));
  const typing: TypingIndicator | null =
    streaming && !hasStreamingMessage
      ? {
          av: avatarForAgent(typingAgentName),
          icon: iconForAgent(typingAgentName),
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

  // --- projects (your multi-agent workplace sessions) ---
  const projects: Project[] = useMemo(
    () =>
      sessions
        .filter(isWorkplaceProject)
        .map((s) => ({ id: s.id, name: getWorkplaceProjectName(s), active: s.id === sessionId })),
    [sessions, sessionId]
  );
  const moderatorAgentId = normalizeModeratorAgentId(currentSession?.origin?.ext?.[CHANNEL_HOST_EXT_KEY]);

  // --- actions ---
  const [sendProjectMessage] = useSendProjectMessageMutation();
  const [approveTool] = useApproveToolMutation();
  const [approveNativeCliSession] = useApproveNativeCliSessionMutation();
  const [abortSession] = useAbortSessionMutation();
  const [updateSession] = useUpdateSessionMutation();
  const [inputNativeCliSession] = useInputNativeCliSessionMutation();
  const [stopNativeCliSession] = useStopNativeCliSessionMutation();

  const sendDirective = useCallback(
    async (text: string) => {
      if (!sessionId) return;
      await traceProjectDebugOperation({ layer: 'web', label: 'project.message.send', sessionId, data: { text } }, () =>
        sendProjectMessage({ projectId: sessionId, text }).unwrap()
      );
    },
    [sessionId, sendProjectMessage]
  );

  const resolveApproval = useCallback(
    (requestId: string, decision: ApprovalDecision) => {
      const approval = approvals.find((candidate) => candidate.id === requestId);
      if (approval?.approvalOwnership === 'provider-owned' && approval.nativeCliSessionId) {
        void traceProjectDebugOperation(
          {
            layer: 'web',
            label: 'native-cli.approval.resolve',
            sessionId: approval.nativeCliSessionId,
            data: { requestId, decision }
          },
          () =>
            approveNativeCliSession({
              id: approval.nativeCliSessionId as string,
              requestId,
              allow: decision === 'approve',
              ...(decision === 'reject' ? { reason: 'denied by operator' } : {})
            }).unwrap()
        );
        return;
      }
      void traceProjectDebugOperation(
        {
          layer: 'web',
          label: 'tool.approval.resolve',
          sessionId: sessionId ?? undefined,
          data: { requestId, decision }
        },
        () =>
          approveTool({
            requestId,
            allow: decision === 'approve',
            scope: 'once',
            ...(decision === 'reject' ? { reason: 'denied by operator' } : {})
          }).unwrap()
      );
    },
    [approveNativeCliSession, approveTool, approvals, sessionId]
  );

  const approveAll = useCallback(() => {
    for (const a of approvals) {
      if (a.approvalOwnership === 'provider-owned' && a.nativeCliSessionId) {
        void approveNativeCliSession({ id: a.nativeCliSessionId, requestId: a.id, allow: true });
        continue;
      }
      void approveTool({ requestId: a.id, allow: true, scope: 'once' });
    }
  }, [approveNativeCliSession, approveTool, approvals]);

  const pauseAll = useCallback(() => {
    if (sessionId) void abortSession(sessionId);
  }, [sessionId, abortSession]);

  const switchProject = useCallback((id: string) => setSessionId(id as SessionId), []);

  const updateProjectMembers = useCallback(
    async (nextMembers: ProjectMember[]) => {
      if (!currentSession?.origin) return;
      await updateSession({
        id: currentSession.id,
        origin: {
          ...currentSession.origin,
          ext: {
            ...(currentSession.origin.ext ?? {}),
            [PROJECT_MEMBERS_EXT_KEY]: nextMembers.map(({ type, name, settings }) => ({
              type,
              name,
              ...(settings && Object.keys(settings).length > 0 ? { settings } : {})
            }))
          }
        }
      }).unwrap();
    },
    [currentSession, updateSession]
  );

  const availableProjectMembers = useMemo(() => {
    const current = new Set(projectMembers.map((member) => member.id));
    return [
      ...acp.agents
        .filter((agent) => !current.has(projectMemberId('acp', agent.name)))
        .map((agent) => ({
          id: projectMemberId('acp', agent.name),
          type: 'acp' as const,
          name: agent.name,
          label: agent.name,
          tag: 'ACP',
          enabled: agent.enabled,
          icon: iconForAgent(agent.name)
        })),
      ...nativeCli.agents
        .filter((agent) => !current.has(projectMemberId('native-cli', agent.name)))
        .map((agent) => ({
          id: projectMemberId('native-cli', agent.name),
          type: 'native-cli' as const,
          name: agent.name,
          label: agent.name,
          tag: nativeCliTag(agent.provider),
          enabled: agent.enabled,
          icon: nativeCliIcon(agent.provider)
        }))
    ];
  }, [acp.agents, nativeCli.agents, projectMembers]);

  const addProjectMember = useCallback(
    async (type: ProjectMemberType, name: string) => {
      if (projectMembers.some((member) => member.type === type && member.name === name)) return;
      const acpAgent = type === 'acp' ? acp.agents.find((agent) => agent.name === name) : undefined;
      const nativeAgent = type === 'native-cli' ? nativeCli.agents.find((agent) => agent.name === name) : undefined;
      const settings: ProjectMemberSettings =
        type === 'acp'
          ? {
              ...(acpAgent?.cwd ? { cwd: acpAgent.cwd } : {}),
              ...(acpAgent?.osSandbox !== undefined ? { osSandbox: acpAgent.osSandbox } : {}),
              ...(acpAgent?.forwardMcp !== undefined ? { forwardMcp: acpAgent.forwardMcp } : {})
            }
          : {
              ...(nativeAgent?.defaultLaunchMode ? { launchMode: nativeAgent.defaultLaunchMode } : {})
            };
      await updateProjectMembers([...projectMembers, { id: projectMemberId(type, name), type, name, settings }]);
    },
    [acp.agents, nativeCli.agents, projectMembers, updateProjectMembers]
  );

  const removeProjectMember = useCallback(
    async (id: string) => {
      await updateProjectMembers(projectMembers.filter((member) => member.id !== id));
    },
    [projectMembers, updateProjectMembers]
  );

  const updateProjectMemberSettings = useCallback(
    async (id: string, patch: ProjectMemberSettings) => {
      await updateProjectMembers(
        projectMembers.map((member) =>
          member.id === id ? { ...member, settings: { ...(member.settings ?? {}), ...patch } } : member
        )
      );
    },
    [projectMembers, updateProjectMembers]
  );

  const sendNativeCliInput = useCallback(
    async (id: string, input: string) => {
      await traceProjectDebugOperation(
        { layer: 'web', label: 'native-cli.input', sessionId: id, data: { id, input } },
        () => inputNativeCliSession({ id, input }).unwrap()
      );
    },
    [inputNativeCliSession]
  );
  const stopNativeCli = useCallback(
    async (id: string) => {
      await traceProjectDebugOperation({ layer: 'web', label: 'native-cli.stop', sessionId: id, data: { id } }, () =>
        stopNativeCliSession(id).unwrap()
      );
    },
    [stopNativeCliSession]
  );

  const setModeratorAgentId = useCallback(
    async (hostId: string | undefined) => {
      if (!currentSession?.origin) return;
      const studioAgentId =
        hostId?.startsWith('agent:') || hostId?.startsWith('agt_')
          ? agents.find((agent) => studioHostId(agent.id) === hostId || agent.id === hostId)?.id
          : undefined;
      const acpAgentName = hostId?.startsWith('acp:')
        ? acp.agents.find((agent) => acpHostId(agent.name) === hostId)?.name
        : undefined;
      if (hostId && !studioAgentId && !acpAgentName) return;
      const nextHostId = studioAgentId
        ? studioHostId(studioAgentId)
        : acpAgentName
          ? acpHostId(acpAgentName)
          : undefined;
      const ext = { ...(currentSession.origin.ext ?? {}) };
      if (nextHostId) ext[CHANNEL_HOST_EXT_KEY] = nextHostId;
      else delete ext[CHANNEL_HOST_EXT_KEY];
      await updateSession({
        id: currentSession.id,
        agentId: (studioAgentId as AgentId | undefined) ?? null,
        origin: {
          ...currentSession.origin,
          ext
        }
      }).unwrap();
    },
    [acp.agents, agents, currentSession, updateSession]
  );

  const setWorkdir = useCallback(
    async (path: string) => {
      if (!currentSession) return;
      await updateSession({ id: currentSession.id, cwd: path }).unwrap();
    },
    [currentSession, updateSession]
  );

  return useMemo(
    () => ({
      projectId,
      sessionId,
      ready: sessionId !== null,
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
      moderator: {
        agents: [
          ...agents.map((agent) => ({ id: studioHostId(agent.id), name: agent.name })),
          ...acp.agents.map((agent) => ({ id: acpHostId(agent.name), name: `${agent.name} (ACP)` }))
        ],
        moderatorAgentId,
        setModeratorAgentId
      },
      workdir: { path: currentSession?.cwd, set: setWorkdir },
      paused: false,
      mentionTargets: railAgents.map((a) => ({ id: a.id, name: a.name })),
      // actions
      sendDirective,
      resolveApproval,
      approveAll,
      pauseAll,
      switchProject,
      addProjectMember,
      removeProjectMember,
      updateProjectMemberSettings,
      sendNativeCliInput,
      stopNativeCli
    }),
    [
      projectId,
      sessionId,
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
      agents,
      acp.agents,
      moderatorAgentId,
      setModeratorAgentId,
      currentSession?.cwd,
      setWorkdir,
      sendDirective,
      resolveApproval,
      approveAll,
      pauseAll,
      switchProject,
      addProjectMember,
      removeProjectMember,
      updateProjectMemberSettings,
      sendNativeCliInput,
      stopNativeCli
    ]
  );
}

export type ProjectController = ReturnType<typeof useProject>;
