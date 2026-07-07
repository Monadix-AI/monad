import type { NativeCliObservationEvent, NativeCliProvider, NativeCliSessionView, UIItem } from '@monad/protocol';

import {
  classifyNativeCliActivity,
  nativeCliEventsAreGenerating,
  nativeCliStreamItems,
  nativeCliStructuredEvents
} from './native-cli-observation/native-cli-observation.ts';

export type WorkspaceExperiencePresence = 'online' | 'working' | 'needs-login' | 'failed' | 'stopped' | 'idle';
export type WorkspaceExperienceAgentActivityPhase = 'reading' | 'thinking' | 'speaking' | 'tooling' | 'writing';

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

export function nativeCliAgentFacingCommandPhase(
  text: string | undefined
): WorkspaceExperienceAgentActivityPhase | undefined {
  const normalized = text?.toLowerCase() ?? '';
  if (!normalized) return undefined;
  // CLI bridge (`monad project post`) and MCP bridge (`mcp__monad__project_post`, `agent_send`) both
  // mean the agent is talking to the room — surface it as "speaking" rather than a generic tool call.
  // No leading \b on the MCP tool names — they arrive prefixed (`mcp__monad__project_post`), and `_`
  // is a word char so \b would not match at the `__project_post` seam.
  if (/\bmonad\s+project\s+(post|send)\b/.test(normalized)) return 'speaking';
  if (/(project_post|agent_send)\b/.test(normalized)) return 'speaking';
  if (
    /\bmonad\s+project\s+read\b/.test(normalized) ||
    /\bmonad\s+project\s+inbox\s+(check|read)\b/.test(normalized) ||
    /\bmonad\s+inbox\s+(check|read)\b/.test(normalized)
  ) {
    return 'reading';
  }
  if (/(project_read|project_inbox_check|inbox_check)\b/.test(normalized)) return 'reading';
  return undefined;
}

function newestNativeCliSession(sessions: NativeCliSessionView[]): NativeCliSessionView | undefined {
  return [...sessions].sort((a, b) => {
    const bTime = b.updatedAt || b.startedAt;
    const aTime = a.updatedAt || a.startedAt;
    return bTime.localeCompare(aTime);
  })[0];
}

function eventTimestampMs(item: NativeCliObservationEvent, fallbackIso: string | undefined): number | undefined {
  const parsed = Date.parse(item.createdAt ?? fallbackIso ?? '');
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasRecentUserMessage(session: NativeCliSessionView, windowMs: number): boolean {
  const observedAt = session.updatedAt || session.startedAt;
  const observedAtMs = Date.parse(observedAt);
  if (!Number.isFinite(observedAtMs)) return false;
  const items = nativeCliStreamItems({
    id: session.id,
    provider: session.provider,
    output: session.outputSnapshot,
    observedAt
  });
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!item) continue;
    if (classifyNativeCliActivity(item, { provider: session.provider }) !== 'user') continue;
    const itemMs = eventTimestampMs(item, observedAt);
    return itemMs !== undefined && observedAtMs - itemMs >= 0 && observedAtMs - itemMs <= windowMs;
  }
  return false;
}

// Map the provider-agnostic activity kind (owned by the adapter) to a UI phase. The two special cases —
// posting to / reading the room — are Monad-domain (our own tools), applied on top of a tool call, not
// provider-specific.
function activityPhaseFromItems(
  items: NativeCliObservationEvent[],
  provider: NativeCliProvider | string | undefined
): WorkspaceExperienceAgentActivityPhase | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!item) continue;
    const kind = classifyNativeCliActivity(item, { provider });
    if (kind === 'turn-end') return 'thinking';
    if (kind === 'tool-call' || kind === 'tool-result') return nativeCliAgentFacingCommandPhase(item.text) ?? 'tooling';
    if (kind === 'thinking') return 'thinking';
    if (kind === 'message') return 'writing';
    if (kind === 'user') return 'thinking';
  }
  return undefined;
}

function latestGeneratingActivityPhase(session: NativeCliSessionView): WorkspaceExperienceAgentActivityPhase {
  const items = nativeCliStreamItems({
    id: session.id,
    provider: session.provider,
    output: session.outputSnapshot,
    observedAt: session.updatedAt || session.startedAt
  });
  return activityPhaseFromItems(items, session.provider) ?? 'thinking';
}

// A managed-project agent's `native-cli:*` tool card stays `status: 'running'` for the whole session,
// so "running tool" alone can't mean "using a tool". Derive the real phase from the tool's live output
// tail — which updates per-token over the ui-stream — so thinking→tooling→writing actually animate.
function runningToolActivityPhase(
  tool: Extract<UIItem, { kind: 'tool' }>
): WorkspaceExperienceAgentActivityPhase | undefined {
  if (!tool.output) return undefined;
  const provider = tool.tool.startsWith('native-cli:') ? tool.tool.slice('native-cli:'.length) : undefined;
  return activityPhaseFromItems(nativeCliStreamItems({ id: tool.id, provider, output: tool.output }), provider);
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
  // Provider vocabulary lives in each adapter's `classifyActivity`; this consumer just asks the
  // adapter (via classify) whether the turn is in flight. `undefined` (no structured records) → not
  // generating.
  const events = nativeCliStructuredEvents({
    id: session.id,
    provider: session.provider,
    output: session.outputSnapshot,
    observedAt: session.updatedAt || session.startedAt
  });
  return events !== undefined && nativeCliEventsAreGenerating(events, { provider: session.provider });
}

function matchingLiveNativeCliTool(
  agentName: string,
  liveTools: readonly Extract<UIItem, { kind: 'tool' }>[]
): Extract<UIItem, { kind: 'tool' }> | undefined {
  return liveTools.find((item) => {
    if (!item.tool.startsWith('native-cli:')) return false;
    return (item.input as { agent?: unknown } | undefined)?.agent === agentName;
  });
}

// The session snapshot (from the native-CLI sessions list) only refetches at turn boundaries, so it
// stays "generating" after a managed agent's turn settles. The live tool card's `status` — pushed
// per-token over the ui-stream and flipped to non-'running' the moment a turn ends — is authoritative
// when present; only fall back to the snapshot when the agent has no live tool.
export function nativeCliAgentIsGenerating(
  agentName: string,
  liveTools: readonly Extract<UIItem, { kind: 'tool' }>[],
  latest: NativeCliSessionView | undefined
): boolean {
  const liveTool = matchingLiveNativeCliTool(agentName, liveTools);
  if (liveTool) return liveTool.status === 'running';
  return latest ? nativeCliSessionIsGenerating(latest) : false;
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
  liveTools: readonly Extract<UIItem, { kind: 'tool' }>[];
}): WorkspaceExperiencePresence {
  const liveTool = matchingLiveNativeCliTool(agentName, liveTools);
  if (liveTool?.status === 'running') {
    if (hasNativeCliLoginNeed(liveTool.output)) return 'needs-login';
  }
  if (activeAgentNames?.has(agentName)) return 'working';
  const latest = newestNativeCliSession(nativeCliSessions.filter((session) => session.agentName === agentName));
  if (!latest) return enabled ? 'online' : 'idle';
  if ((latest.pendingApprovalCount ?? 0) > 0) return 'working';
  if (nativeCliAgentIsGenerating(agentName, liveTools, latest)) return 'working';
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
  liveTools: readonly Extract<UIItem, { kind: 'tool' }>[];
  nativeCliSessions: NativeCliSessionView[];
}): WorkspaceExperienceAgentActivityPhase | undefined {
  const runningTool = liveTools.find((item) => {
    if (!item.tool.startsWith('native-cli:')) return false;
    const inputAgent = (item.input as { agent?: unknown } | undefined)?.agent;
    return item.status === 'running' && inputAgent === agentName;
  });
  const latest = newestNativeCliSession(nativeCliSessions.filter((session) => session.agentName === agentName));
  if (latest) {
    if (hasRecentUserMessage(latest, 5000)) return 'reading';
    if ((latest.pendingApprovalCount ?? 0) > 0 || latest.state === 'starting') return 'thinking';
    if (nativeCliAgentIsGenerating(agentName, liveTools, latest)) {
      // Prefer the live tool output (per-token over the ui-stream) so mid-turn phase transitions show;
      // fall back to the session snapshot, which only refreshes at turn boundaries.
      return (runningTool ? runningToolActivityPhase(runningTool) : undefined) ?? latestGeneratingActivityPhase(latest);
    }
  }
  // A running `native-cli:*` tool with no generating session is a starting/early turn — read its output
  // for the phase (a real tool call → 'tooling'), defaulting to 'thinking' rather than a flat 'tooling'.
  if (runningTool) return runningToolActivityPhase(runningTool) ?? 'thinking';
  return undefined;
}
