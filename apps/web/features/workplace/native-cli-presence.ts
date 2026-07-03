import type { NativeCliSessionView, UIItem } from '@monad/protocol';
import type { AgentActivityPhase, Presence } from './types';

import { nativeCliStreamItems } from './native-cli-observation';

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
  const items = nativeCliStreamItems({
    id: session.id,
    provider: session.provider,
    output: session.outputSnapshot,
    observedAt: session.updatedAt || session.startedAt
  });
  for (const item of items) {
    const eventType = item.providerEventType;
    if (eventType === 'turn/started') {
      active = true;
      continue;
    }
    if (
      eventType === 'turn/completed' ||
      eventType === 'result' ||
      eventType === 'error' ||
      eventType === 'server_error'
    ) {
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
