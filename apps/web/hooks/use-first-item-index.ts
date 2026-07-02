import { useLayoutEffect, useRef, useState } from 'react';

/** Large base so the index stays positive as older rows are prepended. */
const FIRST_ITEM_BASE = 1_000_000;

/**
 * Tracks Virtuoso's `firstItemIndex` for a reverse-infinite list. When older rows are prepended,
 * the index must drop by exactly the number of rows inserted ABOVE the previous first row so the
 * viewport stays anchored. We measure that by locating the previous first row's id in the new
 * array (list length is an unreliable proxy when rows are grouped/transformed). Resets to the base
 * when the anchor disappears (wholesale change, e.g. switching sessions).
 */
export function useFirstItemIndex<T>(items: T[], getId: (item: T) => string): number {
  const [firstItemIndex, setFirstItemIndex] = useState(FIRST_ITEM_BASE);
  const prevFirstIdRef = useRef<string | null>(null);
  const getIdRef = useRef(getId);
  getIdRef.current = getId;
  useLayoutEffect(() => {
    const newFirst = items.length > 0 ? getIdRef.current(items[0] as T) : null;
    const prevFirst = prevFirstIdRef.current;
    if (prevFirst !== null && newFirst !== prevFirst) {
      const idx = items.findIndex((item) => getIdRef.current(item) === prevFirst);
      if (idx > 0) setFirstItemIndex((f) => f - idx);
      else if (idx === -1) setFirstItemIndex(FIRST_ITEM_BASE);
    }
    prevFirstIdRef.current = newFirst;
  }, [items]);
  return firstItemIndex;
}
