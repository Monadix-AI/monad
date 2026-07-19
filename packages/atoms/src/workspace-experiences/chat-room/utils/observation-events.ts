import type { AgentObservationEvent } from '@monad/protocol';

export function observationEventLoadScope(args: {
  deliveryId?: string;
  meshSessionId?: string;
  eventsBefore?: string;
  observationEpoch?: string;
}): string | undefined {
  if (args.deliveryId || !args.meshSessionId || !args.eventsBefore) return undefined;
  return [args.meshSessionId, args.observationEpoch, args.eventsBefore].filter(Boolean).join(':');
}

export function prependObservationEvents(
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

export interface ObservationEventPage {
  items: AgentObservationEvent[];
  nextCursor?: string;
}

export function observationEventPresentation(args: {
  deliveryId?: string;
  hasPages: boolean;
  eventsRequested: boolean;
}): { active: boolean; includePages: boolean; showButton: boolean } {
  const requiresReveal = Boolean(args.deliveryId);
  const includePages = requiresReveal ? args.eventsRequested : true;
  return {
    active: args.hasPages && includePages,
    includePages,
    showButton: requiresReveal && args.hasPages && !args.eventsRequested
  };
}

export async function findOlderEventPage(args: {
  before?: string;
  currentItems: AgentObservationEvent[];
  load: (before?: string) => Promise<ObservationEventPage>;
}): Promise<ObservationEventPage> {
  let before = args.before;
  const visited = new Set<string>();
  for (;;) {
    const marker = before ?? '__events_start__';
    if (visited.has(marker)) return { items: [] };
    visited.add(marker);

    const page = await args.load(before);
    const currentKeys = new Set(args.currentItems.map((item) => item.dedupeKey ?? item.id));
    const items = page.items.filter((item) => !currentKeys.has(item.dedupeKey ?? item.id));
    if (items.length > 0 || !page.nextCursor) return { items, nextCursor: page.nextCursor };
    before = page.nextCursor;
  }
}
