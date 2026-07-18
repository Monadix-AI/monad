import type {
  ExternalAgentObservationEvent,
  ExternalAgentProvider,
  ExternalAgentSessionView,
  UIItem
} from '@monad/protocol';

import {
  classifyExternalAgentActivity,
  externalAgentEventsAreGenerating,
  externalAgentNeutralStreamItems,
  externalAgentStreamItems,
  externalAgentStructuredEvents
} from './external-agent-observation/external-agent-observation.ts';

export type WorkspaceExperiencePresence = 'online' | 'working' | 'needs-login' | 'failed' | 'stopped' | 'idle';
export type WorkspaceExperienceAgentActivityPhase = 'reading' | 'thinking' | 'speaking' | 'tooling' | 'writing';

function hasExternalAgentLoginNeed(text: string | undefined): boolean {
  const normalized = text?.toLowerCase() ?? '';
  return (
    normalized.includes('connection_required') ||
    normalized.includes('login required') ||
    normalized.includes('not authenticated') ||
    normalized.includes('unauthenticated') ||
    normalized.includes('sign in')
  );
}

function externalAgentOutputNeedsLogin(args: { id: string; output?: string; provider?: string }): boolean {
  if (!args.output) return false;
  const structured = externalAgentStructuredEvents({ id: args.id, provider: args.provider, output: args.output });
  if (structured === undefined) return hasExternalAgentLoginNeed(args.output);
  const items = externalAgentNeutralStreamItems({ id: args.id, provider: args.provider, output: args.output });
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!item) continue;
    if (item.kind === 'system' || item.kind === 'unknown' || item.kind === 'turn-end') {
      if (hasExternalAgentLoginNeed(item.text)) return true;
      continue;
    }
    if (
      item.kind === 'assistant-message' ||
      item.kind === 'tool-call' ||
      item.kind === 'tool-result' ||
      item.kind === 'user-message'
    ) {
      return false;
    }
  }
  return false;
}

export function externalAgentFacingCommandPhase(
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

function newestExternalAgentSession(sessions: ExternalAgentSessionView[]): ExternalAgentSessionView | undefined {
  return [...sessions].sort((a, b) => {
    const aLive = a.state === 'running' || a.state === 'starting';
    const bLive = b.state === 'running' || b.state === 'starting';
    if (aLive !== bLive) return bLive ? 1 : -1;
    const bTime = b.updatedAt || b.startedAt;
    const aTime = a.updatedAt || a.startedAt;
    const byTime = bTime.localeCompare(aTime);
    return byTime === 0 ? b.id.localeCompare(a.id) : byTime;
  })[0];
}

function eventTimestampMs(item: ExternalAgentObservationEvent, fallbackIso: string | undefined): number | undefined {
  const parsed = Date.parse(item.createdAt ?? fallbackIso ?? '');
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasRecentUserMessage(session: ExternalAgentSessionView, windowMs: number): boolean {
  const observedAt = session.updatedAt || session.startedAt;
  const observedAtMs = Date.parse(observedAt);
  if (!Number.isFinite(observedAtMs)) return false;
  const items = externalAgentStreamItems({
    id: session.id,
    provider: session.provider,
    output: session.outputSnapshot,
    observedAt
  });
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!item) continue;
    if (classifyExternalAgentActivity(item, { provider: session.provider }) !== 'user') continue;
    const itemMs = eventTimestampMs(item, observedAt);
    return itemMs !== undefined && observedAtMs - itemMs >= 0 && observedAtMs - itemMs <= windowMs;
  }
  return false;
}

// Map the provider-agnostic activity kind (owned by the adapter) to a UI phase. The two special cases —
// posting to / reading the room — are Monad-domain (our own tools), applied on top of a tool call, not
// provider-specific.
function activityPhaseFromItems(
  items: ExternalAgentObservationEvent[],
  provider: ExternalAgentProvider | string | undefined
): WorkspaceExperienceAgentActivityPhase | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!item) continue;
    const kind = classifyExternalAgentActivity(item, { provider });
    if (kind === 'turn-end') return 'thinking';
    if (kind === 'tool-call' || kind === 'tool-result') return externalAgentFacingCommandPhase(item.text) ?? 'tooling';
    if (kind === 'thinking') return 'thinking';
    if (kind === 'message') return 'writing';
    if (kind === 'user') return 'thinking';
  }
  return undefined;
}

function latestGeneratingActivityPhase(session: ExternalAgentSessionView): WorkspaceExperienceAgentActivityPhase {
  const items = externalAgentStreamItems({
    id: session.id,
    provider: session.provider,
    output: session.outputSnapshot,
    observedAt: session.updatedAt || session.startedAt
  });
  return activityPhaseFromItems(items, session.provider) ?? 'thinking';
}

// A managed-project agent's `external-agent:*` tool card stays `status: 'running'` for the whole session,
// so "running tool" alone can't mean "using a tool". Derive the real phase from the tool's live output
// tail — which updates per-token over the ui-stream — so thinking→tooling→writing actually animate.
function runningToolActivityPhase(
  tool: Extract<UIItem, { kind: 'tool' }>
): WorkspaceExperienceAgentActivityPhase | undefined {
  if (!tool.output) return undefined;
  const provider = tool.tool.startsWith('external-agent:') ? tool.tool.slice('external-agent:'.length) : undefined;
  return activityPhaseFromItems(externalAgentStreamItems({ id: tool.id, provider, output: tool.output }), provider);
}

// Callers evaluate this several times per member per recompute, and each evaluation
// would re-parse the session's full outputSnapshot (up to 256KB JSONL). Cache the flag
// per session id keyed on the snapshot so the parse runs once per snapshot change.
const externalAgentGeneratingCache = new Map<string, { snapshot: string | undefined; value: boolean }>();
const EXTERNAL_AGENT_GENERATING_CACHE_LIMIT = 128;

export function externalAgentSessionIsGenerating(session: ExternalAgentSessionView): boolean {
  if (session.runtimeRole !== 'managed-project-agent' || session.state !== 'running') return false;
  const cached = externalAgentGeneratingCache.get(session.id);
  if (cached && cached.snapshot === session.outputSnapshot) return cached.value;
  const value = computeExternalAgentSessionIsGenerating(session);
  if (!cached && externalAgentGeneratingCache.size >= EXTERNAL_AGENT_GENERATING_CACHE_LIMIT) {
    const oldest = externalAgentGeneratingCache.keys().next().value;
    if (oldest !== undefined) externalAgentGeneratingCache.delete(oldest);
  }
  externalAgentGeneratingCache.set(session.id, { snapshot: session.outputSnapshot, value });
  return value;
}

function computeExternalAgentSessionIsGenerating(session: ExternalAgentSessionView): boolean {
  // Provider vocabulary lives in each adapter's `classifyActivity`; this consumer just asks the
  // adapter (via classify) whether the turn is in flight. `undefined` (no structured records) → not
  // generating.
  const events = externalAgentStructuredEvents({
    id: session.id,
    provider: session.provider,
    output: session.outputSnapshot,
    observedAt: session.updatedAt || session.startedAt
  });
  return events !== undefined && externalAgentEventsAreGenerating(events, { provider: session.provider });
}

function matchingLiveExternalAgentTool(
  agentName: string,
  liveTools: readonly Extract<UIItem, { kind: 'tool' }>[]
): Extract<UIItem, { kind: 'tool' }> | undefined {
  return liveTools.find((item) => {
    if (!item.tool.startsWith('external-agent:')) return false;
    return (item.input as { agent?: unknown } | undefined)?.agent === agentName;
  });
}

// The session snapshot (from the external agent sessions list) only refetches at turn boundaries, so it
// stays "generating" after a managed agent's turn settles. The live tool card's `status` — pushed
// per-token over the ui-stream and flipped to non-'running' the moment a turn ends — is authoritative
// when present; only fall back to the snapshot when the agent has no live tool.
export function externalAgentIsGenerating(
  agentName: string,
  liveTools: readonly Extract<UIItem, { kind: 'tool' }>[],
  latest: ExternalAgentSessionView | undefined
): boolean {
  const liveTool = matchingLiveExternalAgentTool(agentName, liveTools);
  if (liveTool) return liveTool.status === 'running';
  return latest ? externalAgentSessionIsGenerating(latest) : false;
}

export function externalAgentMemberPresence({
  activeAgentNames,
  agentName,
  enabled,
  externalAgentSessions,
  liveTools
}: {
  activeAgentNames?: ReadonlySet<string>;
  agentName: string;
  enabled: boolean;
  externalAgentSessions: ExternalAgentSessionView[];
  liveTools: readonly Extract<UIItem, { kind: 'tool' }>[];
}): WorkspaceExperiencePresence {
  const liveTool = matchingLiveExternalAgentTool(agentName, liveTools);
  if (liveTool?.status === 'running') {
    if (
      externalAgentOutputNeedsLogin({
        id: liveTool.id,
        output: liveTool.output,
        provider: liveTool.tool.slice('external-agent:'.length)
      })
    )
      return 'needs-login';
  }
  if (activeAgentNames?.has(agentName)) return 'working';
  const latest = newestExternalAgentSession(externalAgentSessions.filter((session) => session.agentName === agentName));
  if (!latest) return enabled ? 'online' : 'idle';
  if ((latest.pendingApprovalCount ?? 0) > 0) return 'working';
  if (externalAgentIsGenerating(agentName, liveTools, latest)) return 'working';
  if (latest.state === 'running') return 'online';
  if (latest.state === 'starting') return 'working';
  if (
    externalAgentOutputNeedsLogin({
      id: latest.id,
      output: latest.outputSnapshot,
      provider: latest.provider
    })
  )
    return 'needs-login';
  if (latest.state === 'failed') return 'failed';
  if (latest.state === 'stopped' || latest.state === 'exited') return enabled ? 'online' : 'stopped';
  return enabled ? 'online' : 'idle';
}

export function externalAgentMemberActivityPhase({
  agentName,
  liveTools,
  externalAgentSessions
}: {
  agentName: string;
  liveTools: readonly Extract<UIItem, { kind: 'tool' }>[];
  externalAgentSessions: ExternalAgentSessionView[];
}): WorkspaceExperienceAgentActivityPhase | undefined {
  const runningTool = liveTools.find((item) => {
    if (!item.tool.startsWith('external-agent:')) return false;
    const inputAgent = (item.input as { agent?: unknown } | undefined)?.agent;
    return item.status === 'running' && inputAgent === agentName;
  });
  const latest = newestExternalAgentSession(externalAgentSessions.filter((session) => session.agentName === agentName));
  if (latest) {
    if (hasRecentUserMessage(latest, 5000)) return 'reading';
    if ((latest.pendingApprovalCount ?? 0) > 0 || latest.state === 'starting') return 'thinking';
    if (externalAgentIsGenerating(agentName, liveTools, latest)) {
      // Prefer the live tool output (per-token over the ui-stream) so mid-turn phase transitions show;
      // fall back to the session snapshot, which only refreshes at turn boundaries.
      return (runningTool ? runningToolActivityPhase(runningTool) : undefined) ?? latestGeneratingActivityPhase(latest);
    }
  }
  // A running `external-agent:*` tool with no generating session is a starting/early turn — read its output
  // for the phase (a real tool call → 'tooling'), defaulting to 'thinking' rather than a flat 'tooling'.
  if (runningTool) return runningToolActivityPhase(runningTool) ?? 'thinking';
  return undefined;
}
