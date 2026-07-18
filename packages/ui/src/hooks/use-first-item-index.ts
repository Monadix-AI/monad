import { useState } from 'react';

/** Large base so the index stays positive as older rows are prepended. */
const FIRST_ITEM_BASE = 1_000_000;

export interface FirstItemIndexState {
  firstId: string | null;
  value: number;
}

export const initialFirstItemIndexState: FirstItemIndexState = {
  firstId: null,
  value: FIRST_ITEM_BASE
};

export function nextFirstItemIndexState<T>(
  state: FirstItemIndexState,
  items: T[],
  getId: (item: T) => string
): FirstItemIndexState {
  const firstId = items[0] === undefined ? null : getId(items[0]);
  if (firstId === state.firstId) return state;
  const previousOffset = state.firstId === null ? -1 : items.findIndex((item) => getId(item) === state.firstId);
  return {
    firstId,
    value: previousOffset > 0 ? state.value - previousOffset : previousOffset === -1 ? FIRST_ITEM_BASE : state.value
  };
}

/**
 * Tracks Virtuoso's `firstItemIndex` for a reverse-infinite list. When older rows are prepended,
 * the index must drop by exactly the number of rows inserted ABOVE the previous first row so the
 * viewport stays anchored. We measure that by locating the previous first row's id in the new
 * array (list length is an unreliable proxy when rows are grouped/transformed). Resets to the base
 * when the anchor disappears (wholesale change, e.g. switching sessions).
 */
export function useFirstItemIndex<T>(items: T[], getId: (item: T) => string): number {
  const firstId = items[0] === undefined ? null : getId(items[0]);
  const [state, setState] = useState<FirstItemIndexState>({ firstId, value: FIRST_ITEM_BASE });
  if (state.firstId === firstId) return state.value;
  const next = nextFirstItemIndexState(state, items, getId);
  setState(next);
  return next.value;
}
