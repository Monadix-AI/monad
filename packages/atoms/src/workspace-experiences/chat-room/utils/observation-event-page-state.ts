import type { MeshAgentStreamView } from '../../experience/types.ts';

import { prependObservationEvents } from './observation-events.ts';

export interface ObservationEventPageState {
  error: boolean;
  exhausted: boolean;
  items: MeshAgentStreamView['items'];
  loading: boolean;
  nextCursor: string | null;
}

export function beginObservationEventLoad(
  current: ObservationEventPageState | undefined,
  cursor: string
): ObservationEventPageState {
  return {
    error: false,
    exhausted: false,
    items: current?.items ?? [],
    loading: true,
    nextCursor: cursor
  };
}

export function completeObservationEventLoad(
  current: ObservationEventPageState,
  page: { items: MeshAgentStreamView['items']; nextCursor?: string }
): ObservationEventPageState {
  return {
    error: false,
    exhausted: !page.nextCursor,
    items: prependObservationEvents(page.items, current.items),
    loading: false,
    nextCursor: page.nextCursor ?? null
  };
}

export function failObservationEventLoad(current: ObservationEventPageState): ObservationEventPageState {
  return { ...current, error: true, exhausted: false, loading: false };
}
