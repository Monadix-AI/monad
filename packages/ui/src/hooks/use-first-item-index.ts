import { useState } from 'react';

/** Large base so the index stays positive as older rows are prepended. */
const FIRST_ITEM_BASE = 1_000_000;
const RETAINED_ANCHOR_COUNT = 64;

export interface FirstItemIndexState {
  anchors: string[];
  firstId: string | null;
  value: number;
}

export const initialFirstItemIndexState: FirstItemIndexState = {
  anchors: [],
  firstId: null,
  value: FIRST_ITEM_BASE
};

function leadingIds<T>(items: T[], getId: (item: T) => string): string[] {
  return items.slice(0, RETAINED_ANCHOR_COUNT).map(getId);
}

function survivingAnchorOffset(previous: string[], current: string[]): number | undefined {
  const currentIndexes = new Map(current.map((id, index) => [id, index]));
  for (const [previousIndex, id] of previous.entries()) {
    const currentIndex = currentIndexes.get(id);
    if (currentIndex !== undefined) return currentIndex - previousIndex;
  }
  return undefined;
}

export function nextFirstItemIndexState<T>(
  state: FirstItemIndexState,
  items: T[],
  getId: (item: T) => string
): FirstItemIndexState {
  const firstId = items[0] === undefined ? null : getId(items[0]);
  if (firstId === state.firstId) return state;
  const anchors = leadingIds(items, getId);
  const offset = survivingAnchorOffset(state.anchors, anchors);
  return {
    anchors,
    firstId,
    value: offset === undefined ? FIRST_ITEM_BASE : state.value - offset
  };
}

/**
 * Tracks Virtuoso's `firstItemIndex` for a reverse-infinite list. When older rows are prepended,
 * the index must drop by exactly the number of rows inserted ABOVE the previous first row so the
 * viewport stays anchored. A bounded set of leading row ids survives boundary regrouping that can
 * remove the previous first row. The index resets only when none of those anchors survives.
 */
export function useFirstItemIndex<T>(items: T[], getId: (item: T) => string): number {
  const firstId = items[0] === undefined ? null : getId(items[0]);
  const [state, setState] = useState<FirstItemIndexState>({
    anchors: leadingIds(items, getId),
    firstId,
    value: FIRST_ITEM_BASE
  });
  if (state.firstId === firstId) return state.value;
  const next = nextFirstItemIndexState(state, items, getId);
  setState(next);
  return next.value;
}
