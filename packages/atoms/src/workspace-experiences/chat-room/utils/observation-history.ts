import type { AgentObservationEvent } from '@monad/protocol';

function observationTime(item: AgentObservationEvent): number | undefined {
  if (!item.at) return undefined;
  const value = Date.parse(item.at);
  return Number.isNaN(value) ? undefined : value;
}

export function oldestObservationTimestamp(items: AgentObservationEvent[]): string | undefined {
  let oldest: { at: string; value: number } | undefined;
  for (const item of items) {
    const value = observationTime(item);
    if (value === undefined || (oldest && value >= oldest.value)) continue;
    oldest = { at: item.at as string, value };
  }
  return oldest?.at;
}

export function historyItemsBefore(items: AgentObservationEvent[], liveBoundaryAt: string): AgentObservationEvent[] {
  const boundary = Date.parse(liveBoundaryAt);
  if (Number.isNaN(boundary)) return [];
  return items.filter((item) => {
    const value = observationTime(item);
    return value !== undefined && value < boundary;
  });
}

export function prependObservationHistory(
  pageItems: AgentObservationEvent[],
  currentItems: AgentObservationEvent[]
): AgentObservationEvent[] {
  return [...pageItems, ...currentItems];
}

export interface ObservationHistoryPage {
  items: AgentObservationEvent[];
  nextCursor?: string;
}

export async function findOlderObservationPage(args: {
  before?: string;
  liveBoundaryAt: string;
  load: (before?: string) => Promise<ObservationHistoryPage>;
}): Promise<ObservationHistoryPage> {
  let before = args.before;
  const visited = new Set<string>();
  for (;;) {
    const marker = before ?? '__history_start__';
    if (visited.has(marker)) return { items: [] };
    visited.add(marker);

    const page = await args.load(before);
    const items = historyItemsBefore(page.items, args.liveBoundaryAt);
    if (items.length > 0 || !page.nextCursor) return { items, nextCursor: page.nextCursor };
    before = page.nextCursor;
  }
}
