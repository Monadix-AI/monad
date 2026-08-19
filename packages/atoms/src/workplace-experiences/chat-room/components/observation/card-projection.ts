import type { AgentObservationEvent } from '@monad/protocol';
import type { MeshAgentObservationProjector, MeshAgentObservationToolRun } from '@monad/sdk-atom';

import { agentObservationProvenanceSchema } from '@monad/protocol';
import { z } from 'zod';

import { claudeCodeObservationProjection } from '../../../../agent-adapters/claude-code/observation.ts';
import { codexObservationProjection } from '../../../../agent-adapters/codex/observation/index.ts';
import { geminiObservationProjection } from '../../../../agent-adapters/gemini/observation.ts';
import { hermesObservationProjection } from '../../../../agent-adapters/hermes/observation.ts';
import { monadObservationProjection } from '../../../../agent-adapters/monad/observation.ts';
import { openClawObservationProjection } from '../../../../agent-adapters/openclaw/observation.ts';
import { qwenObservationProjection } from '../../../../agent-adapters/qwen/observation.ts';

// The experience layer's view model turns neutral `AgentObservationEvent`s and adapter-declared
// tool runs into renderable units (a tool card, an MCP startup-progress collapse, …). The daemon
// never produces or parses this — only `agentObservationCards()` below constructs it — so it lives
// here rather than in `@monad/protocol` or the third-party `@monad/sdk-atom` authoring contract.
export const agentObservationCardKindSchema = z.enum([
  'message',
  'reasoning',
  'tool',
  'turn',
  'context-compaction',
  'diagnostic',
  'system',
  'unknown',
  'mcp-startup-progress',
  'plan-progress'
]);
export type AgentObservationCardKind = z.infer<typeof agentObservationCardKindSchema>;

export const agentObservationCardSchema = z.object({
  id: z.string().min(1),
  dedupeKey: z.string().min(1).optional(),
  kind: agentObservationCardKindSchema,
  streaming: z.boolean(),
  payload: z.record(z.string(), z.unknown()),
  provenance: agentObservationProvenanceSchema,
  at: z.string().optional()
});
export type AgentObservationCard = z.infer<typeof agentObservationCardSchema>;

function eventIdentity(event: AgentObservationEvent): string {
  return event.id;
}

function cardProvenance(events: AgentObservationEvent[]): AgentObservationCard['provenance'] {
  return { contractEvents: events.flatMap((event) => event.provenance.contractEvents) as [unknown, ...unknown[]] };
}

type McpStartupUpdate = {
  name: string;
  status: string;
  error?: string;
  failureReason?: string;
  threadId?: string;
};

function mcpStartupSnapshot(event: AgentObservationEvent): McpStartupUpdate[] | null {
  const progress = event.progress;
  if (progress?.kind !== 'mcp-startup' || progress.snapshot !== true) return null;
  return progress.servers.map((server) => ({ ...server }));
}

function mcpStartupUpdates(event: AgentObservationEvent): McpStartupUpdate[] | null {
  const progress = event.progress;
  if (progress?.kind !== 'mcp-startup' || progress.snapshot === true) return null;
  const scope = progress.scopeId ? { threadId: progress.scopeId } : {};
  return progress.servers.map((server) => ({ ...server, ...scope }));
}

function collapseMcpStartupUpdates(updates: readonly McpStartupUpdate[]): McpStartupUpdate[] {
  const collapsed: McpStartupUpdate[] = [];
  const indexByName = new Map<string, number>();
  for (const update of updates) {
    const index = indexByName.get(update.name);
    if (index === undefined) {
      indexByName.set(update.name, collapsed.length);
      collapsed.push(update);
    } else {
      collapsed[index] = update;
    }
  }
  return collapsed;
}

const MCP_STARTUP_READY = new Set(['ready', 'connected']);
const MCP_STARTUP_FAILED = new Set(['failed', 'needs-auth']);
// A cancelled or disabled server never finishes starting, so it must settle the card instead of
// leaving it pending — otherwise the running indicator counts up forever.
const MCP_STARTUP_SKIPPED = new Set(['cancelled', 'canceled', 'disabled']);

type McpStartupGroup = {
  events: AgentObservationEvent[];
  updates: McpStartupUpdate[];
};

// Codex reports MCP startup one server at a time, and the batches are interleaved with unrelated
// notifications (`thread/settings/updated`, `turn/started`, …). Grouping by adjacency would split a
// single boot into a "starting" card and a later "ready/failed" card, so the whole window is keyed
// by thread instead and rendered as one progress card.
function mcpStartupGroups(events: readonly AgentObservationEvent[]): Map<AgentObservationEvent, McpStartupGroup> {
  const byThread = new Map<string, McpStartupGroup>();
  const anchors = new Map<AgentObservationEvent, McpStartupGroup>();
  for (const event of events) {
    const snapshot = mcpStartupSnapshot(event);
    if (snapshot) {
      anchors.set(event, { events: [event], updates: snapshot });
      continue;
    }
    const updates = mcpStartupUpdates(event);
    if (!updates || updates.length === 0) continue;
    const key = updates[0]?.threadId ?? '';
    const group = byThread.get(key);
    if (group) {
      group.events.push(event);
      group.updates.push(...updates);
      continue;
    }
    const started: McpStartupGroup = { events: [event], updates };
    byThread.set(key, started);
    anchors.set(event, started);
  }
  return anchors;
}

function startupCard(events: AgentObservationEvent[], updates: McpStartupUpdate[]): AgentObservationCard {
  const first = events[0];
  const last = events[events.length - 1];
  if (!first || !last) throw new Error('startup card requires at least one event');
  const servers = collapseMcpStartupUpdates(updates);
  const ready = servers.filter((server) => MCP_STARTUP_READY.has(server.status)).length;
  const failed = servers.filter((server) => MCP_STARTUP_FAILED.has(server.status)).length;
  const skipped = servers.filter((server) => MCP_STARTUP_SKIPPED.has(server.status)).length;
  const pending = servers.filter(
    (server) =>
      !MCP_STARTUP_READY.has(server.status) &&
      !MCP_STARTUP_FAILED.has(server.status) &&
      !MCP_STARTUP_SKIPPED.has(server.status)
  );
  const active = pending[pending.length - 1]?.name;
  return {
    id: `mcp-startup:${eventIdentity(first)}`,
    kind: 'mcp-startup-progress',
    streaming: pending.length > 0 || last.streaming,
    payload: {
      servers,
      total: servers.length,
      ready,
      failed,
      skipped,
      pending: pending.length,
      ...(active ? { active } : {})
    },
    provenance: cardProvenance(events),
    ...(last.at ? { at: last.at } : {})
  };
}

type PlanStep = {
  status: string;
  step: string;
};

type PlanSnapshot = {
  steps: PlanStep[];
  turnId?: string;
};

function planSnapshot(event: AgentObservationEvent): PlanSnapshot | null {
  const progress = event.progress;
  if (progress?.kind !== 'plan') return null;
  return {
    steps: progress.steps.map((step) => ({ ...step })),
    ...(progress.scopeId ? { turnId: progress.scopeId } : {})
  };
}

type PlanGroup = {
  events: AgentObservationEvent[];
  snapshot: PlanSnapshot;
};

// Every `turn/plan/updated` carries the whole plan, so a turn's later frames supersede its earlier
// ones instead of adding to them — the card keeps one row per turn and renders the newest snapshot.
function planGroups(events: readonly AgentObservationEvent[]): Map<AgentObservationEvent, PlanGroup> {
  const byTurn = new Map<string, PlanGroup>();
  const anchors = new Map<AgentObservationEvent, PlanGroup>();
  for (const event of events) {
    const snapshot = planSnapshot(event);
    if (!snapshot) continue;
    const group = byTurn.get(snapshot.turnId ?? '');
    if (group) {
      group.events.push(event);
      group.snapshot = snapshot;
      continue;
    }
    const started: PlanGroup = { events: [event], snapshot };
    byTurn.set(snapshot.turnId ?? '', started);
    anchors.set(event, started);
  }
  return anchors;
}

function planCard(group: PlanGroup): AgentObservationCard {
  const first = group.events[0];
  const last = group.events[group.events.length - 1];
  if (!first || !last) throw new Error('plan card requires at least one event');
  const steps = group.snapshot.steps;
  const completed = steps.filter((step) => step.status === 'completed').length;
  const active = steps.find((step) => step.status === 'inProgress')?.step;
  return {
    id: `plan:${eventIdentity(first)}`,
    kind: 'plan-progress',
    streaming: completed < steps.length,
    payload: {
      completed,
      steps,
      total: steps.length,
      ...(active ? { active } : {})
    },
    provenance: cardProvenance(group.events),
    ...(last.at ? { at: last.at } : {})
  };
}

function toolCard(run: MeshAgentObservationToolRun, provider: string): AgentObservationCard {
  const events = run.result ? [run.call, run.result] : [run.call];
  return {
    id: eventIdentity(run.call),
    ...(run.call.dedupeKey ? { dedupeKey: run.call.dedupeKey } : {}),
    kind: 'tool',
    streaming: run.streaming,
    payload: run.result ? { provider, call: run.call, result: run.result } : { provider, call: run.call },
    provenance: cardProvenance(events),
    ...((run.result?.at ?? run.call.at) ? { at: run.result?.at ?? run.call.at } : {})
  };
}

function adapterToolRuns(events: readonly AgentObservationEvent[], provider: string): MeshAgentObservationToolRun[] {
  let projection: MeshAgentObservationProjector | undefined;
  switch (provider) {
    case 'claude-code':
      projection = claudeCodeObservationProjection;
      break;
    case 'codex':
      projection = codexObservationProjection;
      break;
    case 'gemini':
      projection = geminiObservationProjection;
      break;
    case 'hermes':
      projection = hermesObservationProjection;
      break;
    case 'monad':
      projection = monadObservationProjection;
      break;
    case 'openclaw':
      projection = openClawObservationProjection;
      break;
    case 'qwen':
      projection = qwenObservationProjection;
      break;
  }
  return projection?.toolRuns?.(events) ?? [];
}

function eventCard(event: AgentObservationEvent, provider: string): AgentObservationCard {
  const kind =
    event.kind === 'tool-call' || event.kind === 'tool-result'
      ? 'tool'
      : event.kind === 'user-message' || event.kind === 'assistant-message'
        ? 'message'
        : event.kind === 'turn-start' || event.kind === 'turn-end'
          ? 'turn'
          : event.kind === 'reasoning'
            ? 'reasoning'
            : event.diagnostic
              ? 'diagnostic'
              : event.kind;
  return {
    id: eventIdentity(event),
    ...(event.dedupeKey ? { dedupeKey: event.dedupeKey } : {}),
    kind,
    streaming: event.streaming,
    payload: { provider, event },
    provenance: cardProvenance([event]),
    ...(event.at ? { at: event.at } : {})
  };
}

export function agentObservationCards(
  events: readonly AgentObservationEvent[],
  provider: string
): AgentObservationCard[] {
  const toolRuns = adapterToolRuns(events, provider);
  const toolRunsByCall = new Map(toolRuns.map((run) => [run.call, run]));
  const pairedResults = new Set(toolRuns.flatMap((run) => run.consumed));
  const startupAnchors = mcpStartupGroups(events);
  const planAnchors = planGroups(events);
  const cards: AgentObservationCard[] = [];

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event) continue;
    if (pairedResults.has(event)) continue;

    const startupGroup = startupAnchors.get(event);
    if (startupGroup) {
      cards.push(startupCard(startupGroup.events, startupGroup.updates));
      continue;
    }
    if (event.progress?.kind === 'mcp-startup') continue;

    const planGroup = planAnchors.get(event);
    if (planGroup) {
      cards.push(planCard(planGroup));
      continue;
    }
    if (event.progress?.kind === 'plan') continue;

    if (event.kind === 'tool-call') {
      const run = toolRunsByCall.get(event);
      cards.push(run ? toolCard(run, provider) : eventCard(event, provider));
      continue;
    }

    if (event.kind === 'tool-result') {
      cards.push(eventCard(event, provider));
      continue;
    }

    cards.push(eventCard(event, provider));
  }

  return cards;
}
