import type { AgentObservationEvent } from '@monad/protocol';

export function observationHistoryLoadScope(args: {
  deliveryId?: string;
  externalAgentSessionId?: string;
  historyBefore?: string;
  observationEpoch?: string;
}): string | undefined {
  if (args.deliveryId || !args.externalAgentSessionId || !args.historyBefore) return undefined;
  return [args.externalAgentSessionId, args.observationEpoch, args.historyBefore].filter(Boolean).join(':');
}

export function prependObservationHistory(
  pageItems: AgentObservationEvent[],
  currentItems: AgentObservationEvent[]
): AgentObservationEvent[] {
  const seen = new Set<string>();
  return [...pageItems, ...currentItems].filter((item) => {
    const identity = item.dedupeKey ?? item.id;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export interface ObservationHistoryPage {
  items: AgentObservationEvent[];
  nextCursor?: string;
}

export function observationHistoryPresentation(args: {
  deliveryId?: string;
  hasPages: boolean;
  historyRequested: boolean;
}): { active: boolean; includePages: boolean; showButton: boolean } {
  const requiresReveal = Boolean(args.deliveryId);
  const includePages = requiresReveal ? args.historyRequested : true;
  return {
    active: args.hasPages && includePages,
    includePages,
    showButton: requiresReveal && args.hasPages && !args.historyRequested
  };
}

export async function findOlderObservationPage(args: {
  before?: string;
  currentItems: AgentObservationEvent[];
  load: (before?: string) => Promise<ObservationHistoryPage>;
}): Promise<ObservationHistoryPage> {
  let before = args.before;
  const visited = new Set<string>();
  for (;;) {
    const marker = before ?? '__history_start__';
    if (visited.has(marker)) return { items: [] };
    visited.add(marker);

    const page = await args.load(before);
    const currentKeys = new Set(args.currentItems.map((item) => item.dedupeKey ?? item.id));
    const items = page.items.filter((item) => !currentKeys.has(item.dedupeKey ?? item.id));
    if (items.length > 0 || !page.nextCursor) return { items, nextCursor: page.nextCursor };
    before = page.nextCursor;
  }
}
