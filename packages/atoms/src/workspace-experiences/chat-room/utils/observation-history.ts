import type { AgentObservationEvent } from '@monad/protocol';

export function observationHistoryLoadScope(args: {
  deliveryId?: string;
  externalAgentSessionId?: string;
  observationEpoch?: string;
  providerHistoryCheckpoint?: string;
}): string | undefined {
  if (args.deliveryId || !args.externalAgentSessionId || !args.observationEpoch || !args.providerHistoryCheckpoint)
    return undefined;
  return `${args.externalAgentSessionId}:${args.observationEpoch}:${args.providerHistoryCheckpoint}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function providerObservationIdentity(item: AgentObservationEvent): string | undefined {
  const raw = record(item.raw);
  if (!raw) return undefined;
  if (typeof raw.uuid === 'string' && raw.uuid) return raw.uuid;
  const params = record(raw.params);
  const turn = record(params?.turn);
  if (typeof params?.turnId === 'string' && params.turnId) return params.turnId;
  return typeof turn?.id === 'string' && turn.id ? turn.id : undefined;
}

function providerObservationCheckpoint(item: AgentObservationEvent): string | undefined {
  const raw = record(item.raw);
  if (!raw) return undefined;
  if (typeof raw.uuid === 'string' && raw.uuid) return raw.uuid;
  return raw.method === 'turn/completed' ? providerObservationIdentity(item) : undefined;
}

export function historyItemsThroughCheckpoint(
  items: AgentObservationEvent[],
  checkpoint: string
): AgentObservationEvent[] | undefined {
  const index = items.findIndex((item) => providerObservationCheckpoint(item) === checkpoint);
  return index < 0 ? undefined : items.slice(0, index + 1);
}

export function prependObservationHistory(
  pageItems: AgentObservationEvent[],
  currentItems: AgentObservationEvent[]
): AgentObservationEvent[] {
  const canonicalIdentities = new Set(
    pageItems.map(providerObservationIdentity).filter((value) => value !== undefined)
  );
  return [
    ...pageItems,
    ...currentItems.filter((item) => {
      const identity = providerObservationIdentity(item);
      return !identity || !canonicalIdentities.has(identity);
    })
  ];
}

export interface ObservationHistoryPage {
  items: AgentObservationEvent[];
  nextCursor?: string;
}

export async function findOlderObservationPage(args: {
  before?: string;
  checkpoint?: string;
  load: (before?: string) => Promise<ObservationHistoryPage>;
}): Promise<ObservationHistoryPage> {
  if (args.before) return args.load(args.before);
  if (!args.checkpoint) return { items: [] };
  let before = args.before;
  const visited = new Set<string>();
  for (;;) {
    const marker = before ?? '__history_start__';
    if (visited.has(marker)) return { items: [] };
    visited.add(marker);

    const page = await args.load(before);
    const items = historyItemsThroughCheckpoint(page.items, args.checkpoint);
    if (items) return { items, nextCursor: page.nextCursor };
    if (!page.nextCursor) return { items: [] };
    before = page.nextCursor;
  }
}
