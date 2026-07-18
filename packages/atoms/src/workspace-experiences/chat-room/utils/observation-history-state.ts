import type { ExternalAgentStreamView } from '../../experience/types.ts';

import { prependObservationHistory } from './observation-history.ts';

export interface ObservationHistoryPageState {
  error: boolean;
  exhausted: boolean;
  items: ExternalAgentStreamView['items'];
  loading: boolean;
  nextCursor: string | null;
}

export function beginObservationHistoryLoad(
  current: ObservationHistoryPageState | undefined,
  cursor: string
): ObservationHistoryPageState {
  return {
    error: false,
    exhausted: false,
    items: current?.items ?? [],
    loading: true,
    nextCursor: cursor
  };
}

export function completeObservationHistoryLoad(
  current: ObservationHistoryPageState,
  page: { items: ExternalAgentStreamView['items']; nextCursor?: string }
): ObservationHistoryPageState {
  return {
    error: false,
    exhausted: !page.nextCursor,
    items: prependObservationHistory(page.items, current.items),
    loading: false,
    nextCursor: page.nextCursor ?? null
  };
}

export function failObservationHistoryLoad(current: ObservationHistoryPageState): ObservationHistoryPageState {
  return { ...current, error: true, exhausted: false, loading: false };
}
