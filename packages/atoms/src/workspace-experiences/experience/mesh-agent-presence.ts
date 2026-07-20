import type {
  AgentObservationEvent,
  MeshAgentObservationEvent,
  MeshAgentProvider,
  MeshSessionView,
  UIItem
} from '@monad/protocol';

import {
  classifyMeshAgentActivity,
  meshAgentNeutralStreamItems,
  meshAgentStreamItems,
  meshAgentStructuredEvents
} from './mesh-agent-observation/mesh-agent-observation.ts';

export type WorkspaceExperiencePresence = 'online' | 'working' | 'needs-login' | 'failed' | 'stopped' | 'idle';
export type WorkspaceExperienceAgentActivityPhase = 'reading' | 'thinking' | 'speaking' | 'tooling' | 'writing';

function hasMeshAgentLoginNeed(text: string | undefined): boolean {
  const normalized = text?.toLowerCase() ?? '';
  return (
    normalized.includes('connection_required') ||
    normalized.includes('login required') ||
    normalized.includes('not authenticated') ||
    normalized.includes('unauthenticated') ||
    normalized.includes('sign in')
  );
}

function meshAgentOutputNeedsLogin(args: { id: string; output?: string; provider?: string }): boolean {
  if (!args.output) return false;
  const structured = meshAgentStructuredEvents({ id: args.id, provider: args.provider, output: args.output });
  if (structured === undefined) return hasMeshAgentLoginNeed(args.output);
  const items = meshAgentNeutralStreamItems({ id: args.id, provider: args.provider, output: args.output });
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!item) continue;
    if (item.kind === 'system' || item.kind === 'unknown' || item.kind === 'turn-end') {
      if (hasMeshAgentLoginNeed(item.text)) return true;
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

export function meshAgentFacingCommandPhase(
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

function meshAgentObservationToolPhase(event: AgentObservationEvent): WorkspaceExperienceAgentActivityPhase {
  const byToolName = meshAgentFacingCommandPhase(event.tool?.name);
  if (byToolName) return byToolName;
  const byText = meshAgentFacingCommandPhase(event.text);
  return byText ?? 'tooling';
}

export function meshAgentObservationActivity(events: readonly AgentObservationEvent[]): {
  active: boolean;
  phase?: WorkspaceExperienceAgentActivityPhase;
} {
  let active = false;
  let phase: WorkspaceExperienceAgentActivityPhase | undefined;
  for (const event of events) {
    if (event.kind === 'turn-start') {
      active = true;
      phase = 'thinking';
      continue;
    }
    if (event.kind === 'turn-end') {
      active = false;
      phase = undefined;
      continue;
    }
    if (!active) continue;
    if (event.kind === 'reasoning') phase = 'thinking';
    else if (event.kind === 'assistant-message') phase = 'writing';
    else if (event.kind === 'user-message') phase = 'reading';
    else if (event.kind === 'tool-call' || event.kind === 'tool-result') {
      phase = meshAgentObservationToolPhase(event);
    }
  }
  return active ? { active, phase: phase ?? 'thinking' } : { active };
}

function newestMeshSession(sessions: MeshSessionView[]): MeshSessionView | undefined {
  return [...sessions].sort((a, b) => {
    const aLive = a.lifecycle.state !== 'terminal';
    const bLive = b.lifecycle.state !== 'terminal';
    if (aLive !== bLive) return bLive ? 1 : -1;
    const bTime = b.updatedAt || b.startedAt;
    const aTime = a.updatedAt || a.startedAt;
    const byTime = bTime.localeCompare(aTime);
    return byTime === 0 ? b.id.localeCompare(a.id) : byTime;
  })[0];
}

// Map the provider-agnostic activity kind (owned by the adapter) to a UI phase. The two special cases —
// posting to / reading the room — are Monad-domain (our own tools), applied on top of a tool call, not
// provider-specific.
function activityPhaseFromItems(
  items: MeshAgentObservationEvent[],
  provider: MeshAgentProvider | string | undefined
): WorkspaceExperienceAgentActivityPhase | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!item) continue;
    const kind = classifyMeshAgentActivity(item, { provider });
    if (kind === 'turn-end') return 'thinking';
    if (kind === 'tool-call' || kind === 'tool-result') return meshAgentFacingCommandPhase(item.text) ?? 'tooling';
    if (kind === 'thinking') return 'thinking';
    if (kind === 'message') return 'writing';
    if (kind === 'user') return 'thinking';
  }
  return undefined;
}

// A managed-project agent's `mesh-agent:*` tool card stays `status: 'running'` for the whole session,
// so "running tool" alone can't mean "using a tool". Derive the real phase from the tool's live output
// tail — which updates per-token over the ui-stream — so thinking→tooling→writing actually animate.
function runningToolActivityPhase(
  tool: Extract<UIItem, { kind: 'tool' }>
): WorkspaceExperienceAgentActivityPhase | undefined {
  if (!tool.output) return undefined;
  const provider = tool.tool.startsWith('mesh-agent:') ? tool.tool.slice('mesh-agent:'.length) : undefined;
  return activityPhaseFromItems(meshAgentStreamItems({ id: tool.id, provider, output: tool.output }), provider);
}

export function meshSessionIsGenerating(session: MeshSessionView): boolean {
  return (
    session.runtimeRole === 'managed-project-agent' &&
    session.lifecycle.state === 'active' &&
    (session.activity.state === 'starting' || session.activity.state === 'running')
  );
}

function matchingLiveMeshAgentTool(
  agentName: string,
  liveTools: readonly Extract<UIItem, { kind: 'tool' }>[]
): Extract<UIItem, { kind: 'tool' }> | undefined {
  return liveTools.find((item) => {
    if (!item.tool.startsWith('mesh-agent:')) return false;
    return (item.input as { agent?: unknown } | undefined)?.agent === agentName;
  });
}

// A long-lived MeshAgent tool card can be `ok` while its daemon session is in a turn, so only
// `running` is useful as an early positive signal. Neutral observation turn boundaries are the
// authoritative source once the Chat experience subscription is ready.
export function meshAgentIsGenerating(
  agentName: string,
  liveTools: readonly Extract<UIItem, { kind: 'tool' }>[],
  latest: MeshSessionView | undefined
): boolean {
  const liveTool = matchingLiveMeshAgentTool(agentName, liveTools);
  if (liveTool?.status === 'running') return true;
  return latest ? meshSessionIsGenerating(latest) : false;
}

export function meshAgentMemberPresence({
  activeAgentNames,
  agentName,
  enabled,
  meshSessions,
  liveTools,
  observationEvents
}: {
  activeAgentNames?: ReadonlySet<string>;
  agentName: string;
  enabled: boolean;
  meshSessions: MeshSessionView[];
  liveTools: readonly Extract<UIItem, { kind: 'tool' }>[];
  observationEvents?: readonly AgentObservationEvent[];
}): WorkspaceExperiencePresence {
  if (observationEvents) return meshAgentObservationActivity(observationEvents).active ? 'working' : 'idle';
  const liveTool = matchingLiveMeshAgentTool(agentName, liveTools);
  if (liveTool?.status === 'running') {
    if (
      meshAgentOutputNeedsLogin({
        id: liveTool.id,
        output: liveTool.output,
        provider: liveTool.tool.slice('mesh-agent:'.length)
      })
    )
      return 'needs-login';
  }
  if (activeAgentNames?.has(agentName)) return 'working';
  const latest = newestMeshSession(meshSessions.filter((session) => session.agentName === agentName));
  if (!latest) return 'idle';
  if ((latest.pendingApprovalCount ?? 0) > 0) return 'working';
  if (meshAgentIsGenerating(agentName, liveTools, latest)) return 'working';
  if (latest.lifecycle.state === 'starting') return 'working';
  if (latest.lifecycle.state === 'active') return 'online';
  if (latest.lifecycle.termination.kind === 'failed') return 'failed';
  if (latest.lifecycle.termination.kind === 'stopped' || latest.lifecycle.termination.kind === 'exited')
    return enabled ? 'online' : 'stopped';
  return enabled ? 'online' : 'idle';
}

export function meshAgentMemberActivityPhase({
  agentName,
  liveTools,
  meshSessions,
  observationEvents
}: {
  agentName: string;
  liveTools: readonly Extract<UIItem, { kind: 'tool' }>[];
  meshSessions: MeshSessionView[];
  observationEvents?: readonly AgentObservationEvent[];
}): WorkspaceExperienceAgentActivityPhase | undefined {
  if (observationEvents) return meshAgentObservationActivity(observationEvents).phase;
  const runningTool = liveTools.find((item) => {
    if (!item.tool.startsWith('mesh-agent:')) return false;
    const inputAgent = (item.input as { agent?: unknown } | undefined)?.agent;
    return item.status === 'running' && inputAgent === agentName;
  });
  const latest = newestMeshSession(meshSessions.filter((session) => session.agentName === agentName));
  if (latest) {
    if ((latest.pendingApprovalCount ?? 0) > 0 || latest.lifecycle.state === 'starting') return 'thinking';
    if (meshAgentIsGenerating(agentName, liveTools, latest)) {
      // Prefer the live tool output (per-token over the ui-stream) so mid-turn phase transitions show;
      // fall back to the session snapshot, which only refreshes at turn boundaries.
      return (runningTool ? runningToolActivityPhase(runningTool) : undefined) ?? 'thinking';
    }
  }
  // A running `mesh-agent:*` tool with no generating session is a starting/early turn — read its output
  // for the phase (a real tool call → 'tooling'), defaulting to 'thinking' rather than a flat 'tooling'.
  if (runningTool) return runningToolActivityPhase(runningTool) ?? 'thinking';
  return undefined;
}
