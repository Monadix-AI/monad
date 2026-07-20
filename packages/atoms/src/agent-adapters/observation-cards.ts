import type { AgentObservationEvent } from '@monad/protocol';

import { agentObservationProvenanceSchema } from '@monad/protocol';
import { z } from 'zod';

// The experience layer's view model grouping/pairing neutral `AgentObservationEvent`s into
// renderable units (a tool call+result pair, a codex MCP startup-progress collapse, …). The daemon
// never produces or parses this — only `agentObservationCards()` below constructs it — so it lives
// here rather than in `@monad/protocol` or the third-party `@monad/sdk-atom` authoring contract.
export const agentObservationCardKindSchema = z.enum([
  'message',
  'reasoning',
  'tool',
  'turn',
  'diagnostic',
  'system',
  'unknown',
  'codex-mcp-startup-progress'
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

type CodexMcpStartupUpdate = {
  name: string;
  status: string;
  error?: string;
};

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function codexMcpStartupUpdate(event: AgentObservationEvent): CodexMcpStartupUpdate | null {
  const raw = recordValue(event.provenance.contractEvents[0]);
  if (raw?.method !== 'mcpServer/startupStatus/updated') return null;
  const params = recordValue(raw.params);
  if (!params) return null;
  const error = textValue(params.error);
  return {
    name: textValue(params.name) ?? 'unknown',
    status: textValue(params.status) ?? 'updated',
    ...(error ? { error } : {})
  };
}

function collapseCodexMcpStartupUpdates(updates: readonly CodexMcpStartupUpdate[]): CodexMcpStartupUpdate[] {
  const collapsed: CodexMcpStartupUpdate[] = [];
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

function startupCard(events: AgentObservationEvent[], updates: CodexMcpStartupUpdate[]): AgentObservationCard {
  const first = events[0];
  const last = events[events.length - 1];
  if (!first || !last) throw new Error('startup card requires at least one event');
  return {
    id: `codex-mcp-startup:${eventIdentity(first)}`,
    kind: 'codex-mcp-startup-progress',
    streaming: last.streaming,
    payload: { updates: collapseCodexMcpStartupUpdates(updates) },
    provenance: cardProvenance(events),
    ...(last.at ? { at: last.at } : {})
  };
}

function toolCard(
  call: AgentObservationEvent,
  result: AgentObservationEvent | undefined,
  provider: string
): AgentObservationCard {
  const events = result ? [call, result] : [call];
  return {
    id: eventIdentity(call),
    ...(call.dedupeKey ? { dedupeKey: call.dedupeKey } : {}),
    kind: 'tool',
    streaming: result ? result.streaming : true,
    payload: result ? { provider, call, result } : { provider, call },
    provenance: cardProvenance(events),
    ...((result?.at ?? call.at) ? { at: result?.at ?? call.at } : {})
  };
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

function toolResultIndexesByCallId(events: readonly AgentObservationEvent[]): Map<string, AgentObservationEvent[]> {
  const results = new Map<string, AgentObservationEvent[]>();
  for (const event of events) {
    if (event.kind !== 'tool-result' || !event.tool?.callId) continue;
    const bucket = results.get(event.tool.callId) ?? [];
    bucket.push(event);
    results.set(event.tool.callId, bucket);
  }
  return results;
}

export function agentObservationCards(
  events: readonly AgentObservationEvent[],
  provider: string
): AgentObservationCard[] {
  const resultsByCallId = toolResultIndexesByCallId(events);
  const pairedResults = new Set<AgentObservationEvent>();
  const cards: AgentObservationCard[] = [];

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event) continue;
    if (pairedResults.has(event)) continue;

    const startup = codexMcpStartupUpdate(event);
    if (startup) {
      const startupEvents = [event];
      const updates = [startup];
      while (index + 1 < events.length) {
        const next = events[index + 1];
        if (!next) break;
        const nextUpdate = codexMcpStartupUpdate(next);
        if (!nextUpdate) break;
        startupEvents.push(next);
        updates.push(nextUpdate);
        index += 1;
      }
      cards.push(startupCard(startupEvents, updates));
      continue;
    }

    if (event.kind === 'tool-call') {
      const result = event.tool?.callId
        ? resultsByCallId.get(event.tool.callId)?.find((candidate) => !pairedResults.has(candidate))
        : events[index + 1]?.kind === 'tool-result'
          ? events[index + 1]
          : undefined;
      if (result) pairedResults.add(result);
      cards.push(toolCard(event, result, provider));
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
