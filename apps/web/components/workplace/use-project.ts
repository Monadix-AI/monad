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
  Session,
  SessionId,
  UIItem,
  UIMessageItem,
  UIPart
} from '@monad/protocol';
import type { ActivityRow, AgentTask, ApprovalView, Message, Participant, Project, TypingIndicator } from './types';

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
  useListProfilesQuery,
  useListSessionsQuery,
  useSendProjectMessageMutation,
  useStartNativeCliAgentMutation,
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

const messageId = (m: Message): string => m.id;
const CHANNEL_HOST_EXT_KEY = 'workplaceProjectModeratorAgentId';
const PROJECT_MEMBERS_EXT_KEY = 'workplaceProjectMembers';
// Which UI preset (skin) this project last used — the only preset state that persists.
const PRESET_EXT_KEY = 'workplaceProjectPresetId';

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
    ...(reasoning ? { reasoning } : {}),
    streaming: item.status === 'streaming'
  };
}

function iconForAgent(name: string): Participant['icon'] | undefined {
  if (name === 'monad') return 'monad';
  if (name === 'codex') return 'openai';
  if (name === 'claude-code') return 'anthropic';
  return undefined;
}

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
        const provider = agent?.provider ?? (member.name === 'codex' ? 'codex' : 'claude-code');
        return {
          id: member.id,
          av: initials(member.name),
          icon: provider === 'codex' ? 'openai' : 'anthropic',
          name: member.name,
          kind: 'agent',
          tag: provider === 'codex' ? 'Codex' : 'Claude',
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
    const byId = new Map<string, Message>();
    const toView = messageToView;
    for (const view of persistedMessages) byId.set(view.id, view);
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
        streaming: true
      });
    }
    for (const item of liveTools) {
      if (item.status !== 'running' || !item.tool.startsWith('native-cli:')) continue;
      const input = item.input as { agent?: unknown; provider?: unknown } | undefined;
      if (typeof input?.agent !== 'string') continue;
      byId.set(`native-cli-progress:${item.id}`, {
        id: `native-cli-progress:${item.id}`,
        authorId: input.agent,
        authorName: input.agent,
        av: avatarForAgent(input.agent),
        icon: typeof input.provider === 'string' && input.provider === 'codex' ? 'openai' : 'anthropic',
        kind: 'agent',
        tag: typeof input.provider === 'string' && input.provider === 'codex' ? 'Codex' : 'Claude',
        time: '',
        text: item.output ?? '',
        streaming: true
      });
    }
    return [...byId.values()];
  }, [persistedMessages, liveItems, liveTools]);

  const firstItemIndex = useFirstItemIndex(messages, messageId);
  const loadOlder = transcript.loadOlder;

  const typingAgentName = [...runningDelegations][0] ?? 'monad';
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
              ? `${(a.input as { provider: string }).provider === 'codex' ? 'Codex' : 'Claude Code'} approval`
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
  const presetExt = currentSession?.origin?.ext?.[PRESET_EXT_KEY];
  const presetId = typeof presetExt === 'string' ? presetExt : 'chat';

  // --- actions ---
  const [sendProjectMessage] = useSendProjectMessageMutation();
  const [approveTool] = useApproveToolMutation();
  const [approveNativeCliSession] = useApproveNativeCliSessionMutation();
  const [abortSession] = useAbortSessionMutation();
  const [updateSession] = useUpdateSessionMutation();
  const [startNativeCliAgent] = useStartNativeCliAgentMutation();
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
          tag: agent.provider === 'codex' ? 'Codex' : 'Claude',
          enabled: agent.enabled,
          icon: agent.provider === 'codex' ? ('openai' as const) : ('anthropic' as const)
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
      if (type === 'native-cli' && sessionId && currentSession?.cwd && nativeAgent?.enabled) {
        await traceProjectDebugOperation(
          {
            layer: 'web',
            label: 'native-cli.start',
            sessionId,
            data: { agentName: name, workingPath: currentSession.cwd, launchMode: settings.launchMode }
          },
          () =>
            startNativeCliAgent({
              sessionId,
              agentName: name,
              workingPath: currentSession.cwd as string,
              launchMode: settings.launchMode
            }).unwrap()
        );
      }
    },
    [
      acp.agents,
      currentSession?.cwd,
      nativeCli.agents,
      projectMembers,
      sessionId,
      startNativeCliAgent,
      updateProjectMembers
    ]
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

  const setPreset = useCallback(
    async (id: string) => {
      if (!currentSession?.origin) return;
      const ext = { ...(currentSession.origin.ext ?? {}), [PRESET_EXT_KEY]: id };
      await updateSession({ id: currentSession.id, origin: { ...currentSession.origin, ext } }).unwrap();
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
      preset: { id: presetId, set: setPreset },
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
      presetId,
      setPreset,
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
